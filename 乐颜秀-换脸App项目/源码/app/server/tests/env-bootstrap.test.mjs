import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("server env bootstrap loads beside server and preserves runtime overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-env-"));
  const envPath = path.join(tempRoot, ".env");
  fs.writeFileSync(envPath, "PROVIDER=file-default\nENV_BOOTSTRAP_FIXTURE=file-value\n", "utf8");
  try {
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "import { envFile } from './server/env.js'; console.log(JSON.stringify({ envFile, provider: process.env.PROVIDER, fixture: process.env.ENV_BOOTSTRAP_FIXTURE }));",
    ], {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: envPath,
        PROVIDER: "runtime-override",
        ENV_BOOTSTRAP_FIXTURE: "",
      },
    });
    const result = JSON.parse(output.trim());
    assert.equal(result.envFile, envPath);
    assert.equal(result.provider, "runtime-override");
    assert.equal(result.fixture, "");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function providerCheck(overrides) {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const { provider } = await import('./server/index.js'); let result; try { provider(); result = 'allowed'; } catch (error) { result = error.code || error.message; } console.log(JSON.stringify({ result }));",
  ], {
    cwd: appRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: path.join(os.tmpdir(), "leyanxiu-env-file-that-does-not-exist"),
      START_SERVER: "false",
      ...overrides,
    },
  });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}

test("mock provider requires an explicit opt-in and is never allowed in production", () => {
  assert.equal(providerCheck({ DEPLOY_ENV: "staging", PROVIDER: "mock", ALLOW_MOCK_PROVIDER: "false" }).result, "PROVIDER_NOT_CONFIGURED");
  assert.equal(providerCheck({ DEPLOY_ENV: "staging", PROVIDER: "mock", ALLOW_MOCK_PROVIDER: "true" }).result, "allowed");
  assert.equal(providerCheck({ DEPLOY_ENV: "production", PROVIDER: "mock", ALLOW_MOCK_PROVIDER: "true" }).result, "PROVIDER_NOT_CONFIGURED");
});
