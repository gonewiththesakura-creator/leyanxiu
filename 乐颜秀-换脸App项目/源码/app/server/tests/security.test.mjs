import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-security-"));
process.env.START_SERVER = "false";
process.env.NODE_ENV = "test";
process.env.DEPLOY_ENV = "test";
process.env.TASKS_BACKEND = "file";
process.env.TASKS_FILE = path.join(tempRoot, "tasks.json");
process.env.COMPLIANCE_STORE_FILE = path.join(tempRoot, "compliance.json");
process.env.PRIVATE_OBJECT_DIR = path.join(tempRoot, "objects");
process.env.OBJECT_INDEX_FILE = path.join(tempRoot, "objects", "index.json");
process.env.OBJECT_SIGNING_SECRET = "test-object-signing-secret-32-characters";
process.env.AUTH_SESSION_SECRET = "test-auth-session-secret-32-characters";
process.env.CONTENT_POLICY_VERSION = "approved-test-v1";
process.env.CLOSED_TEST_MODE = "true";
process.env.CLOSED_TEST_CREDITS = "3";
process.env.CLOSED_TEST_REQUIRE_INVITE = "true";
process.env.CLOSED_TEST_INVITE_SECRET = "security-test-invite-secret";
process.env.PROVIDER = "mock";
process.env.ALLOW_MOCK_PROVIDER = "true";
process.env.TPL_JINQU_URL = "https://media.example/template.mp4";
process.env.RETENTION_SUPPLIER_POLICY = "test-policy-only";
process.env.SUPPLIER_DELETION_CAPABILITIES_JSON = "{}";
process.env.CORS_ORIGIN = "https://allowed.example";

const VALID_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const [{ app }, { objectStore }, { store, resetStoreForTests }, { runRetentionSweep }, { assertSafeRemoteUrl }] = await Promise.all([
  import("../index.js"),
  import("../storage.js"),
  import("../compliance-store.js"),
  import("../retention.js"),
  import("../network-policy.js"),
]);

function jsonOptions(token, body, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

async function request(url, options = {}) {
  const response = await app.request(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

async function createSession(clientId) {
  const options = jsonOptions(null, { clientId, channel: "h5" });
  options.headers["X-Closed-Test-Invite"] = process.env.CLOSED_TEST_INVITE_SECRET;
  const result = await request("/api/auth/session", options);
  assert.equal(result.response.status, 200);
  return result.body.data.token;
}

async function grantRequiredConsents(token) {
  const basic = await request("/api/consents", jsonOptions(token, { consentType: "basic", action: "granted", purpose: "automated test", dataTypes: ["account"], suppliers: [] }));
  assert.equal(basic.response.status, 200);
  const face = await request("/api/consents", jsonOptions(token, { consentType: "face_processing", action: "granted", purpose: "automated test", dataTypes: ["face-image"], suppliers: ["test-supplier"], subjectAuthorization: "self" }));
  assert.equal(face.response.status, 200);
}

test("identity, consent, private object, moderation, retention and payment gates", async () => {
  resetStoreForTests();
  const missingInvite = await request("/api/auth/session", jsonOptions(null, { clientId: "missing-invite", channel: "h5" }));
  assert.equal(missingInvite.response.status, 403);
  assert.equal(missingInvite.body.code, "INVITE_REQUIRED");
  const wrongInviteOptions = jsonOptions(null, { clientId: "wrong-invite", channel: "h5" });
  wrongInviteOptions.headers["X-Closed-Test-Invite"] = "wrong-invite";
  const wrongInvite = await request("/api/auth/session", wrongInviteOptions);
  assert.equal(wrongInvite.response.status, 403);
  assert.equal(wrongInvite.body.code, "INVITE_REQUIRED");
  await assert.rejects(() => assertSafeRemoteUrl("http://127.0.0.1/internal", { purpose: "test" }), /不允许/);
  await assert.rejects(() => assertSafeRemoteUrl("http://localhost/internal", { purpose: "test" }), /不允许/);
  const tokenA = await createSession("security-a");
  const tokenB = await createSession("security-b");
  await grantRequiredConsents(tokenA);
  await grantRequiredConsents(tokenB);
  const meA = await request("/api/auth/me", { headers: { Authorization: `Bearer ${tokenA}` } });
  const userA = meA.body.data.user.id;

  const order = store.createOrder({ userId: userA, productId: "test-pack", amountFen: 100, credits: 5, channel: "test", idempotencyKey: "ledger-1" });
  const paidDigest = "a".repeat(64);
  const paid = store.applyPaymentEvent({ eventId: "payment-1", orderId: order.order.id, status: "paid", providerTradeId: "trade-1", rawDigest: paidDigest });
  assert.equal(paid.order.status, "paid");
  assert.equal(store.entitlements(userA).purchasedRemaining, 5);
  const duplicatePayment = store.applyPaymentEvent({ eventId: "payment-1", orderId: order.order.id, status: "paid", providerTradeId: "trade-1", rawDigest: paidDigest });
  assert.equal(duplicatePayment.duplicate, true);
  const mutatedPayment = store.applyPaymentEvent({ eventId: "payment-1", orderId: order.order.id, status: "paid", providerTradeId: "trade-2", rawDigest: "b".repeat(64) });
  assert.equal(mutatedPayment.error, "PAYMENT_EVENT_ID_CONFLICT");
  const idempotencyConflict = store.createOrder({ userId: userA, productId: "changed-pack", amountFen: 200, credits: 9, channel: "test", idempotencyKey: "ledger-1" });
  assert.equal(idempotencyConflict.error, "IDEMPOTENCY_KEY_CONFLICT");
  store.applyPaymentEvent({ eventId: "payment-2", orderId: order.order.id, status: "refunded", providerTradeId: "trade-1", rawDigest: "c".repeat(64) });
  assert.equal(store.entitlements(userA).purchasedRemaining, 0);
  assert.equal(store.reconcileEntitlements().ok, true);
  assert.equal(store.countGenerationReservationsSince(new Date(0).toISOString()), 0);
  assert.throws(() => store.countGenerationReservationsSince("not-a-date"), /invalid reservation window/);

  const invalidMedia = await request("/api/upload", jsonOptions(tokenA, { image: "data:image/png;base64,aGVsbG8=" }));
  assert.equal(invalidMedia.response.status, 400);
  assert.equal(invalidMedia.body.code, "MEDIA_TYPE_MISMATCH");
  const upload = await request("/api/upload", jsonOptions(tokenA, { image: VALID_PNG }));
  assert.equal(upload.response.status, 200);
  const assetId = upload.body.data.assetId;
  assert.match(assetId, /^obj_[0-9a-f-]{36}$/);
  const signed = new URL(upload.body.data.url);
  const direct = await request(`${signed.pathname}${signed.search}`);
  assert.equal(direct.response.status, 200);
  assert.match(direct.response.headers.get("cache-control") || "", /private, no-store/);
  assert.equal(direct.response.headers.get("accept-ranges"), "bytes");
  const partial = await request(`${signed.pathname}${signed.search}`, { headers: { Range: "bytes=1-3" } });
  assert.equal(partial.response.status, 206);
  assert.equal(partial.response.headers.get("content-range"), "bytes 1-3/68");
  assert.equal(partial.response.headers.get("content-length"), "3");
  const suffix = await request(`${signed.pathname}${signed.search}`, { headers: { Range: "bytes=-2" } });
  assert.equal(suffix.response.status, 206);
  const invalidRange = await request(`${signed.pathname}${signed.search}`, { headers: { Range: "bytes=10-20" } });
  assert.equal(invalidRange.response.status, 206);
  const invalidRangeBeyond = await request(`${signed.pathname}${signed.search}`, { headers: { Range: "bytes=100-120" } });
  assert.equal(invalidRangeBeyond.response.status, 416);
  assert.equal(invalidRangeBeyond.response.headers.get("content-range"), "bytes */68");

  const refreshed = await request(`/api/assets/${assetId}/url`, { headers: { Authorization: `Bearer ${tokenA}` } });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.data.assetId, assetId);
  assert.equal(refreshed.body.data.contentType, "image/png");
  assert.equal(refreshed.body.data.ext, ".png");
  assert.equal(refreshed.body.data.metadata.width, 1);
  assert.equal(refreshed.body.data.metadata.height, 1);
  assert.match(refreshed.body.data.metadata.consentRecordId, /^consent_/);
  assert.match(refreshed.body.data.url, new RegExp(`/api/objects/${assetId}\\?token=REDACTED_SECRET

  const crossUrl = await request(`/api/assets/${assetId}/url`, { headers: { Authorization: `Bearer ${tokenB}` } });
  assert.equal(crossUrl.response.status, 403);
  const crossModeration = await request("/api/moderation/check", jsonOptions(tokenB, { assetId, direction: "input" }));
  assert.equal(crossModeration.response.status, 403);
  const crossDelete = await request(`/api/assets/${assetId}`, { ...jsonOptions(tokenB, undefined, "DELETE") });
  assert.equal(crossDelete.response.status, 403);
  const report = await request("/api/reports", jsonOptions(tokenA, { category: "rights", description: "这是用于验证加密投诉工单的详细说明", contact: "tester@example.invalid", assetId, templateId: "jinqu" }));
  assert.equal(report.response.status, 202);
  assert.match(report.body.data.ticketId, /^rpt_[0-9a-f-]{36}$/i);
  const storedReport = store.listReports({ limit: 1 })[0];
  assert.equal(storedReport.sensitive.description, "这是用于验证加密投诉工单的详细说明");
  assert.equal(JSON.stringify(store.listAudits()).includes("tester@example.invalid"), false);
  assert.equal(store.listAudits().some((entry) => entry.resourceId === storedReport.id && entry.details?.descriptionDigest), false);
  const invalidReport = await request("/api/reports", jsonOptions(tokenA, { category: "invalid", description: "这是足够长的无效类型说明" }));
  assert.equal(invalidReport.response.status, 400);

  const firstGeneration = await request("/api/fusion", { ...jsonOptions(tokenA, { templateId: "jinqu", userPhotoUrl: upload.body.data.url }), headers: { ...jsonOptions(tokenA).headers, "Idempotency-Key": "generation-fixed-1" } });
  assert.equal(firstGeneration.response.status, 200);
  assert.equal(firstGeneration.body.data.model, "mock-video-fusion");
  const storedTasks = JSON.parse(fs.readFileSync(process.env.TASKS_FILE, "utf8"));
  assert.equal(storedTasks[firstGeneration.body.data.taskId].model, "mock-video-fusion");
  const duplicateGeneration = await request("/api/fusion", { ...jsonOptions(tokenA, { templateId: "jinqu", userPhotoUrl: upload.body.data.url }), headers: { ...jsonOptions(tokenA).headers, "Idempotency-Key": "generation-fixed-1" } });
  assert.equal(duplicateGeneration.response.status, 409);
  assert.equal(duplicateGeneration.body.code, "DUPLICATE_GENERATION_REQUEST");

  const ownedDeleteUpload = await request("/api/upload", jsonOptions(tokenA, { image: VALID_PNG }));
  const ownedDelete = await request(`/api/assets/${ownedDeleteUpload.body.data.assetId}`, jsonOptions(tokenA, undefined, "DELETE"));
  assert.equal(ownedDelete.response.status, 202);
  assert.equal(ownedDelete.body.code, "ERASURE_PARTIAL");
  assert.equal(ownedDelete.body.data.supplierDeletion.status, "blocked_missing_contract");
  const externalInput = await request("/api/photo/restore", jsonOptions(tokenB, { imageUrl: upload.body.data.url, colorize: true }));
  assert.equal(externalInput.response.status, 403);
  const invalidSignature = await request(`/api/objects/${assetId}?token=REDACTED_SECRET
  assert.equal(invalidSignature.response.status, 403);
  const unauthenticated = await request("/api/upload", jsonOptions(null, { image: "data:image/png;base64,aGVsbG8=" }));
  assert.equal(unauthenticated.response.status, 401);

  const moderation = await request("/api/moderation/check", jsonOptions(tokenA, { text: "色情内容", direction: "input" }));
  assert.equal(moderation.response.status, 200);
  assert.equal(moderation.body.data.decision, "block");
  const appeal = await request(`/api/moderation/${moderation.body.data.record.id}/appeal`, jsonOptions(tokenA, { reason: "test appeal" }));
  assert.equal(appeal.response.status, 202);

  const withdraw = await request("/api/consents/face_processing/withdraw", jsonOptions(tokenA, undefined));
  assert.equal(withdraw.response.status, 202);
  assert.equal(withdraw.body.code, "ERASURE_PARTIAL");
  assert.ok(withdraw.body.data.supplierPending.length > 0);
  const afterWithdraw = await request(`${signed.pathname}${signed.search}`);
  assert.equal(afterWithdraw.response.status, 403);

  const payment = await request("/api/orders", jsonOptions(tokenA, { productId: "demo", idempotencyKey: "security-order-1" }));
  assert.equal(payment.response.status, 503);
  assert.equal(payment.body.code, "PAYMENT_NOT_READY");

  const expiring = await objectStore.putBuffer(Buffer.from("retention"), { ownerId: store.snapshot().users.find((user) => user.channel === "h5")?.id, ext: ".bin", purpose: "input/test", metadata: { provider: "test-provider" }, retainSeconds: 60 });
  const sweep = await runRetentionSweep(Date.now() + 120_000);
  assert.ok(sweep.deleted.includes(expiring.id));
  assert.equal(objectStore.get(expiring.id), null);
  assert.ok(sweep.supplierPending.some((entry) => entry.objectId === expiring.id));
  assert.ok(store.listSupplierDeletions().some((entry) => entry.objectId === expiring.id && entry.status === "blocked_missing_contract"));

  const readiness = await request("/api/readiness");
  assert.equal(readiness.response.status, 200);
  assert.equal(readiness.body.data.publicLaunchAllowed, false);
  assert.equal(readiness.body.data.status, "CLOSED_TEST");
  const publicCompliance = await request("/api/public/compliance");
  assert.equal(publicCompliance.response.status, 200);
  assert.equal(publicCompliance.body.data.status, "pending_company_approval");
  assert.equal(Object.hasOwn(publicCompliance.body.data, "blockers"), false);
  assert.equal(JSON.stringify(publicCompliance.body).includes("AUTH_SESSION_SECRET"), false);
  const allowedCors = await request("/health", { headers: { Origin: "https://allowed.example" } });
  assert.equal(allowedCors.response.headers.get("access-control-allow-origin"), "https://allowed.example");
  assert.match(allowedCors.response.headers.get("content-security-policy") || "", /default-src 'self'/);
  assert.match(allowedCors.response.headers.get("permissions-policy") || "", /camera=\(self\)/);
  const deniedCors = await request("/health", { headers: { Origin: "https://evil.example" } });
  assert.notEqual(deniedCors.response.headers.get("access-control-allow-origin"), "https://evil.example");

  const accountDelete = await request("/api/account", jsonOptions(tokenA, undefined, "DELETE"));
  assert.equal(accountDelete.response.status, 200);
  const afterDelete = await request("/api/auth/me", { headers: { Authorization: `Bearer ${tokenA}` } });
  assert.equal(afterDelete.response.status, 401);
  const persistedAfterDelete = JSON.parse(fs.readFileSync(store.file, "utf8"));
  assert.equal(persistedAfterDelete.users[userA].subjectHash, null);
  assert.ok(Object.values(persistedAfterDelete.sessions).filter((session) => session.userId === userA).every((session) => session.tokenHash === null));

  const purgedReports = store.purgeExpiredReportData(Date.now() + 181 * 86_400_000);
  assert.ok(purgedReports.includes(report.body.data.ticketId));
  const retainedTicket = store.listReports({ limit: 10 }).find((item) => item.id === report.body.data.ticketId);
  assert.equal(retainedTicket.sensitive, null);
  assert.equal(retainedTicket.descriptionDigest, null);
  assert.equal(retainedTicket.evidence.networkFingerprint, null);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
