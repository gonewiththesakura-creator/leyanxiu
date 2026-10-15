import { objectStore } from "./storage.js";
import { flushComplianceStore, store } from "./compliance-store.js";
import { alertMetric, increment } from "./metrics.js";
import { requestSupplierDeletion } from "./supplier-lifecycle.js";
import { safeError } from "./security-log.js";
import { stageDrain } from "./stage-drain.js";

const intervalMinutes = Math.max(5, Number(process.env.RETENTION_SWEEP_MINUTES || 60));

export async function runRetentionSweep(now = Date.now()) {
  try {
  const purgedReports = store.purgeExpiredReportData(now);
  const result = await objectStore.sweep(now, { beforeDelete: requestSupplierDeletion });
  increment("retention.sweep");
  increment("retention.deleted", result.deleted.length);
  increment("retention.supplier_pending", result.supplierPending.length);
  increment("retention.report_sensitive_data_purged", purgedReports.length);
  if (result.supplierPending.length) {
    alertMetric("retention.supplier_deletion_pending", { pending: result.supplierPending });
    store.recordAudit({ action: "retention.supplier_deletion_pending", resourceType: "object", details: result.supplierPending });
  }
  if (result.failures.length) {
    increment("retention.failures", result.failures.length);
    alertMetric("retention.delete_failed", { failures: result.failures });
    store.recordAudit({ action: "retention.delete_failed", resourceType: "object", details: result.failures.map(({ objectId, message }) => ({ objectId, message })) });
  }
  store.recordAudit({ action: "retention.sweep", resourceType: "object", details: { scanned: result.scanned, expired: result.expired, deleted: result.deleted.length, failures: result.failures.length, supplierPending: result.supplierPending.length, purgedReports: purgedReports.length } });
  return { ...result, purgedReports };
  } finally { await flushComplianceStore(); }
}

export function startRetentionJob() {
  const timer = setInterval(() => {
    const task = process.env.DEPLOY_ENV === 'staging' ? stageDrain.run(() => runRetentionSweep()) : runRetentionSweep();
    task.catch((error) => { if (error.code !== 'STAGE_DRAINING') alertMetric("retention.sweep_failed", { error: safeError(error) }); });
  }, intervalMinutes * 60_000);
  timer.unref?.();
  return timer;
}
