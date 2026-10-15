import crypto from "node:crypto";
import { flushComplianceStore, store } from "./compliance-store.js";
import { alertMetric } from "./metrics.js";
import { assertSafeRemoteUrl } from "./network-policy.js";
import { safeError } from "./security-log.js";

function parseCapabilities() {
  try {
    const parsed = JSON.parse(process.env.SUPPLIER_DELETION_CAPABILITIES_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function supplierDeletionReadiness() {
  const production = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
  const capabilities = parseCapabilities();
  const blockers = [];
  if (production && !process.env.RETENTION_SUPPLIER_POLICY) blockers.push("RETENTION_SUPPLIER_POLICY must document supplier copy retention and deletion terms");
  if (production && !Object.keys(capabilities).length) blockers.push("SUPPLIER_DELETION_CAPABILITIES_JSON must map every configured provider to a deletion capability");
  if (production) {
    for (const [provider, capability] of Object.entries(capabilities)) {
      if (capability?.supported !== true) blockers.push(`supplier deletion capability is not approved: ${provider}`);
    }
  }
  return { ready: blockers.length === 0, capabilities, blockers };
}

export async function requestSupplierDeletion(record) {
  try {
  const provider = record.metadata?.provider || "unknown";
  const capabilities = parseCapabilities();
  const capability = capabilities[provider] || capabilities["*"];
  if (!capability?.supported) {
    const entry = store.recordSupplierDeletion({ objectId: record.id, provider, status: "blocked_missing_contract", details: { purpose: record.purpose, contentId: record.metadata?.contentId || null } });
    alertMetric("supplier_deletion.blocked", { objectId: record.id, provider });
    return entry;
  }

  const endpoint = capability.endpoint || process.env.SUPPLIER_DELETION_WEBHOOK_URL;
  const secret = capability.secretEnv ? process.env[capability.secretEnv] : process.env.SUPPLIER_DELETION_WEBHOOK_SECRET;
  if (!endpoint || !secret) {
    const entry = store.recordSupplierDeletion({ objectId: record.id, provider, status: "blocked_endpoint_not_configured", details: { purpose: record.purpose } });
    alertMetric("supplier_deletion.blocked", { objectId: record.id, provider, reason: "endpoint_not_configured" });
    return entry;
  }

  const body = JSON.stringify({ objectId: record.id, provider, contentId: record.metadata?.contentId || null, purpose: record.purpose, expiresAt: record.expiresAt });
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.SUPPLIER_DELETION_TIMEOUT_MS || 10_000));
  try {
    const safeEndpoint = await assertSafeRemoteUrl(endpoint, { purpose: "供应商删除回调" });
    const endpointUrl = new URL(safeEndpoint);
    const endpointReference = `${endpointUrl.origin}${endpointUrl.pathname}`;
    const response = await fetch(safeEndpoint, { method: "POST", headers: { "Content-Type": "application/json", "X-Deletion-Signature": signature }, body, signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`supplier deletion returned ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    const confirmed = ["deleted", "confirmed"].includes(String(payload.status || "").toLowerCase());
    return store.recordSupplierDeletion({
      objectId: record.id,
      provider,
      status: confirmed ? "confirmed" : "requested",
      details: { endpoint: endpointReference, purpose: record.purpose, supplierRequestId: payload.requestId || payload.id || null },
    });
  } catch (error) {
    const failure = safeError(error);
    alertMetric("supplier_deletion.failed", { objectId: record.id, provider, error: failure });
    return store.recordSupplierDeletion({ objectId: record.id, provider, status: "failed", details: { failureCode: failure.code || failure.name || "SUPPLIER_DELETE_FAILED" } });
  } finally {
    clearTimeout(timer);
  }
  } finally { await flushComplianceStore(); }
}
