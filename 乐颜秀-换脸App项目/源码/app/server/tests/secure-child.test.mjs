import assert from "node:assert/strict";
import test from "node:test";

const secureChild = await import("../scripts/secure-child.js").catch(() => ({}));

test("JSON stdin transport keeps deployment secrets out of child argv", async () => {
  assert.equal(typeof secureChild.spawnWithJsonStdin, "function");
  const secret = "stage-secret-must-not-appear-in-argv";
  const probe = [
    "const fs=require('node:fs');",
    "const input=fs.readFileSync(0,'utf8');",
    "const payload=JSON.parse(input);",
    "process.stdout.write(JSON.stringify({argv:process.argv,payload}));",
  ].join("");
  const child = secureChild.spawnWithJsonStdin(
    process.execPath,
    ["-e", probe, "public-argument"],
    { secret },
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(code, 0, stderr);
  const received = JSON.parse(stdout);
  assert.equal(received.payload.secret, secret);
  assert.equal(received.argv.some((value) => value.includes(secret)), false);
});

test("deployment child environment removes inherited credentials", () => {
  assert.equal(typeof secureChild.sanitizedChildEnv, "function");
  const sanitized = secureChild.sanitizedChildEnv({
    PATH: "public-path",
    APPDATA: "public-appdata",
    DEBUG: "verbose",
    LEYANXIU_STAGE_OWNER_PASSWORD: "password",
    ALIYUN_ACCESS_KEY_SECRET: "secret",
    INTERNAL_CRON_TOKEN: "token",
    DASHSCOPE_API_KEY: "api-key",
    WX_PRIVATE_KEY: "private-key",
  });
  assert.deepEqual(sanitized, { PATH: "public-path", APPDATA: "public-appdata" });
});

test("deployment diagnostics redact nested admin hashes and escaped environment JSON", () => {
  assert.equal(typeof secureChild.redactDeploymentDiagnostics, "function");
  const passwordHash = "scrypt$16384$8$1$nested-admin-hash";
  const providerKey = "provider-key-secret-value";
  const adminUsersJson = JSON.stringify([{ username: "owner", passwordHash }]);
  const cliDiagnostic = JSON.stringify({
    PUBLIC_BASE_URL: "https://stage.example.test",
    ADMIN_USERS_JSON: adminUsersJson,
    DEEPSEEK_API_KEY: providerKey,
  });
  const redacted = secureChild.redactDeploymentDiagnostics(cliDiagnostic, [passwordHash, providerKey, adminUsersJson]);

  assert.doesNotMatch(redacted, /nested-admin-hash|provider-key-secret-value|passwordHash/i);
  assert.match(redacted, /https:\/\/stage\.example\.test/);
  assert.match(redacted, /\*\*\*/);
});
