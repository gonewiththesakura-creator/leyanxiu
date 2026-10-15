import { assertSafeRemoteUrl } from "./network-policy.js";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export async function fetchProviderJson(url, options = {}, { purpose = "AI supplier API", timeoutMs, maxBytes } = {}) {
  const safeUrl = await assertSafeRemoteUrl(url, { purpose });
  const timeLimit = boundedInteger(timeoutMs ?? process.env.PROVIDER_FETCH_TIMEOUT_MS, 60_000, 1_000, 300_000);
  const byteLimit = boundedInteger(maxBytes ?? process.env.PROVIDER_RESPONSE_MAX_BYTES, 2 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("PROVIDER_FETCH_TIMEOUT")), timeLimit);
  try {
    const response = await fetch(safeUrl, { ...options, redirect: "error", signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > byteLimit) throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
    if (!response.body) return { ok: response.ok, status: response.status, body: {} };
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) {
        await reader.cancel("PROVIDER_RESPONSE_TOO_LARGE").catch(() => {});
        throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); } catch {}
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
