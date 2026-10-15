const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|credential|signature|api[-_]?key|access[-_]?key|image|video|payload|body|content)/i;

export function sanitizeText(value, maxLength = 500) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/(data:[^;,]{1,80};base64,)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|sig|signature|secret|key|code|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, "[REDACTED_AK]")
    .slice(0, maxLength);
}

export function sanitizeDetails(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeDetails(item, depth + 1),
    ]));
  }
  return sanitizeText(value);
}

export function safeError(error) {
  return sanitizeDetails({
    name: error?.name || "Error",
    code: error?.code || null,
    status: error?.status || error?.statusCode || null,
    message: error?.message || "unknown error",
  });
}

export function logSecurity(level, event, details = {}) {
  const entry = JSON.stringify({ level, event: sanitizeText(event, 100), details: sanitizeDetails(details), createdAt: new Date().toISOString() });
  if (level === "error" || level === "alert") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
  return entry;
}

export const securityLog = logSecurity;
