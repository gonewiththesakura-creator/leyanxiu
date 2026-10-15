import { spawn } from "node:child_process";

const SENSITIVE_ENV_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)/i;
const SENSITIVE_DIAGNOSTIC_KEY = "(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL|ENCRYPTION[_-]?KEY)[A-Z0-9_]*|ADMIN_USERS_JSON)";

export function sanitizedChildEnv(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => (
      value !== undefined
      && key.toUpperCase() !== "DEBUG"
      && !SENSITIVE_ENV_KEY.test(key)
    )),
  );
}

export function redactDeploymentDiagnostics(input, secrets = []) {
  let redacted = String(input || "");
  const explicitValues = [...new Set(secrets.map((value) => String(value || "")).filter((value) => value.length >= 8))]
    .sort((left, right) => right.length - left.length);

  for (const value of explicitValues) {
    redacted = redacted.replaceAll(value, "***");
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) redacted = redacted.replaceAll(escaped, "***");
  }

  const jsonValue = new RegExp(`("${SENSITIVE_DIAGNOSTIC_KEY}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi");
  const assignmentValue = new RegExp(`(\\b${SENSITIVE_DIAGNOSTIC_KEY}\\b\\s*[=:]\\s*)(?!\\*\\*\\*)[^\\s,;]+`, "gi");
  return redacted
    .replace(jsonValue, '$1"***"')
    .replace(assignmentValue, "$1***");
}

export function spawnWithJsonStdin(executable, args, payload, options = {}) {
  const child = spawn(executable, args, {
    ...options,
    shell: false,
    stdio: options.stdio || ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin) throw new Error("secure child process stdin is unavailable");
  child.stdin.end(JSON.stringify(payload));
  return child;
}
