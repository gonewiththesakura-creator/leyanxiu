import { assertSafeRemoteUrl } from "./network-policy.js";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export async function fetchRemoteBuffer(url, { purpose = "remote-object", maxBytes, timeoutMs } = {}) {
  const safeUrl = await assertSafeRemoteUrl(url, { purpose });
  const byteLimit = boundedInteger(maxBytes ?? process.env.MAX_OBJECT_BYTES, 100 * 1024 * 1024, 1, 512 * 1024 * 1024);
  const timeLimit = boundedInteger(timeoutMs ?? process.env.OUTBOUND_FETCH_TIMEOUT_MS, 30_000, 1_000, 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OUTBOUND_FETCH_TIMEOUT")), timeLimit);
  try {
    const response = await fetch(safeUrl, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`REMOTE_FETCH_FAILED_${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > byteLimit) throw new Error("REMOTE_OBJECT_TOO_LARGE");
    if (!response.body) throw new Error("REMOTE_RESPONSE_BODY_MISSING");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > byteLimit) {
        await reader.cancel("REMOTE_OBJECT_TOO_LARGE").catch(() => {});
        throw new Error("REMOTE_OBJECT_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}
