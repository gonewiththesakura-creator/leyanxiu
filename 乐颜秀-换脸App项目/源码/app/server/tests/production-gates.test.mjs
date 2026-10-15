import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function identityReadiness(mode, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-auth-gate-"));
  try {
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import { authReadiness, realNameReadiness } from './auth.js'; import { complianceStoreReadiness } from './compliance-store.js'; console.log(JSON.stringify({ auth: authReadiness(), realName: realNameReadiness(), complianceStore: complianceStoreReadiness() }));",
    ], {
      cwd: serverRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DEPLOY_ENV: "production",
        NODE_ENV: "production",
        RELEASE_CHANNEL: "android-app",
        AUTH_MODE: mode,
        AUTH_SESSION_SECRET: "placeholder-production-auth-secret-32-characters",
        CLOSED_TEST_MODE: "false",
        COMPLIANCE_STORE_FILE: path.join(root, "compliance.json"),
        ...extraEnv,
      },
    });
    return JSON.parse(output.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Android production requires recoverable accounts and independently blocks without real-name verification", () => {
  const deviceOnly = identityReadiness("device_key");
  assert.equal(deviceOnly.auth.ready, false);
  assert.ok(deviceOnly.auth.blockers.some(item=>item.includes('APP_LOGIN_ENABLED')));
  assert.equal(deviceOnly.auth.identityScope, "device-possession-only");
  assert.equal(deviceOnly.realName.ready, false);
  assert.ok(deviceOnly.realName.blockers.some((item) => item.includes("independently of device_key")));
  assert.equal(deviceOnly.complianceStore.ready, false);
  assert.equal(deviceOnly.complianceStore.productionSupported, false);

  const configuredButUnimplemented = identityReadiness("device_key", {
    APP_LOGIN_ENABLED: 'true',
    REAL_NAME_AUTH_MODE: "provider",
    REAL_NAME_AUTH_PROVIDER: "contracted-test-provider",
    REAL_NAME_AUTH_VERIFIED: "true",
  });
  assert.equal(configuredButUnimplemented.auth.ready, true);
  assert.equal(configuredButUnimplemented.realName.ready, false);
  assert.equal(configuredButUnimplemented.realName.implemented, false);
  assert.ok(configuredButUnimplemented.realName.blockers.some((item) => item.includes("not implemented")));

  const anonymous = identityReadiness("anonymous");
  assert.equal(anonymous.auth.ready, false);
  assert.ok(anonymous.auth.blockers.some((item) => item.includes("AUTH_MODE=device_key")));
});
