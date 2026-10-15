import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-device-auth-"));
process.env.START_SERVER = "false";
process.env.NODE_ENV = "test";
process.env.DEPLOY_ENV = "test";
process.env.AUTH_MODE = "device_key";
process.env.AUTH_SESSION_SECRET = "test-device-auth-session-secret-32-characters";
process.env.OBJECT_SIGNING_SECRET = "test-device-object-signing-secret-32-characters";
process.env.TASKS_BACKEND = "file";
process.env.TASKS_FILE = path.join(tempRoot, "tasks.json");
process.env.COMPLIANCE_STORE_FILE = path.join(tempRoot, "compliance.json");
process.env.PRIVATE_OBJECT_DIR = path.join(tempRoot, "objects");
process.env.OBJECT_INDEX_FILE = path.join(tempRoot, "objects", "index.json");
process.env.CONTENT_POLICY_VERSION = "approved-test-v1";
process.env.CLOSED_TEST_MODE = "true";
process.env.CLOSED_TEST_CREDITS = "1";

const [{ app }, { store, resetStoreForTests }] = await Promise.all([
  import("../index.js"),
  import("../compliance-store.js"),
]);

async function post(url, body) {
  const response = await app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

function keyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...pair,
    publicKeySpki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
  };
}

async function challenge(publicKeySpki) {
  const result = await post("/api/auth/device/challenge", { algorithm: "ES256", publicKeySpki });
  assert.equal(result.response.status, 200);
  assert.match(result.body.data.challengeId, /^dch_[0-9a-f-]{36}$/i);
  return result.body.data;
}

function signedProof(challengeData, pair, overrides = {}) {
  const signature = crypto.sign("sha256", Buffer.from(challengeData.challenge, "utf8"), pair.privateKey).toString("base64url");
  return {
    challengeId: challengeData.challengeId,
    challenge: challengeData.challenge,
    algorithm: "ES256",
    publicKeySpki: pair.publicKeySpki,
    signature,
    ...overrides,
  };
}

test("P-256 device challenges are bound, short-lived and one-time", async () => {
  resetStoreForTests();
  const primary = keyPair();
  const attacker = keyPair();

  const first = await challenge(primary.publicKeySpki);
  const mismatch = await post("/api/auth/device/verify", signedProof(first, primary, { challenge: `${first.challenge}-tampered` }));
  assert.equal(mismatch.response.status, 400);
  assert.equal(mismatch.body.code, "AUTH_CHALLENGE_MISMATCH");

  const wrongKey = await post("/api/auth/device/verify", signedProof(first, attacker, { publicKeySpki: attacker.publicKeySpki }));
  assert.equal(wrongKey.response.status, 400);
  assert.equal(wrongKey.body.code, "AUTH_CHALLENGE_MISMATCH");

  const accepted = await post("/api/auth/device/verify", signedProof(first, primary));
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.data.user.authMethod, "device_key");
  assert.equal(accepted.body.data.user.channel, "android");
  assert.match(accepted.body.data.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const replay = await post("/api/auth/device/verify", signedProof(first, primary));
  assert.equal(replay.response.status, 409);
  assert.equal(replay.body.code, "AUTH_CHALLENGE_REPLAYED");

  const second = await challenge(primary.publicKeySpki);
  const wrongSignature = crypto.sign("sha256", Buffer.from(second.challenge, "utf8"), attacker.privateKey).toString("base64url");
  const rejected = await post("/api/auth/device/verify", signedProof(second, primary, { signature: wrongSignature }));
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.body.code, "INVALID_DEVICE_SIGNATURE");
  const consumedAfterFailure = await post("/api/auth/device/verify", signedProof(second, primary));
  assert.equal(consumedAfterFailure.response.status, 409);

  const third = await challenge(primary.publicKeySpki);
  const stable = await post("/api/auth/device/verify", signedProof(third, primary));
  assert.equal(stable.response.status, 200);
  assert.equal(stable.body.data.user.id, accepted.body.data.user.id);

  const anonymous = await post("/api/auth/session", { clientId: "spoofed-device-id", channel: "app" });
  assert.equal(anonymous.response.status, 403);
  assert.equal(anonymous.body.code, "AUTH_PROVIDER_REQUIRED");

  const expiredChallenge = `expired|${crypto.randomUUID()}`;
  const expired = store.createAuthChallenge({
    publicKeySpki: primary.publicKeySpki,
    keyFingerprint: "f".repeat(64),
    challengeDigest: crypto.createHash("sha256").update(expiredChallenge).digest("hex"),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const expiredResult = store.consumeAuthChallenge({
    challengeId: expired.id,
    publicKeySpki: primary.publicKeySpki,
    challengeDigest: crypto.createHash("sha256").update(expiredChallenge).digest("hex"),
  });
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.error, "AUTH_CHALLENGE_EXPIRED");
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
