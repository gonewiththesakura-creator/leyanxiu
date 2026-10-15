const fail = code => Object.assign(new Error(code), { code });

async function deadline(operation, timeoutMs) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail('PHOTO_UPLOAD_CLEANUP_IO_UNCONFIRMED')), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

/** Explicitly scheduled, one object per run. Repeating DELETE is idempotent;
 * repeating PUT or moderation is never permitted by this worker.
 * Even repeated HEAD absence leaves a durable future recheck, not a permanent
 * erasure claim or a claim about retained object versions/backups.
 */
export function createPhotoUploadCleanupWorker({ repository, sourceStorage, moderationStorage, policy }) {
  const timeoutMs = policy?.timeoutMs;
  const timing = Object.freeze({ retryAfterMs: policy?.retryAfterMs, recheckAfterMs: policy?.recheckAfterMs,
    inFlightGraceMs: policy?.inFlightGraceMs, claimHoldMs: Math.max(policy?.retryAfterMs || 0, (timeoutMs || 0) * 2 + 1000) });
  if (!['prepareCleanup', 'claimCleanup', 'recordCleanupObservation'].every(name => typeof repository?.[name] === 'function')
    || ![sourceStorage, moderationStorage].every(storage => typeof storage?.delete === 'function' && typeof storage?.inspect === 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000
    || !Number.isSafeInteger(timing.retryAfterMs) || timing.retryAfterMs < 1000 || timing.retryAfterMs > 86400000
    || !Number.isSafeInteger(timing.recheckAfterMs) || timing.recheckAfterMs < timing.retryAfterMs || timing.recheckAfterMs > 7 * 86400000
    || !Number.isSafeInteger(timing.inFlightGraceMs) || timing.inFlightGraceMs < 300000 || timing.inFlightGraceMs > 86400000) throw fail('PHOTO_UPLOAD_CLEANUP_DEPENDENCIES_REQUIRED');
  let accepting = true; const active = new Set();
  async function operate() {
    await repository.prepareCleanup(timing);
    if (!accepting) return null;
    // This commit precedes DELETE, so a lost commit reply never authorizes IO.
    const claim = await repository.claimCleanup(timing); if (!claim) return null;
    const storage = claim.kind === 'source' ? sourceStorage : moderationStorage;
    let deleteAcknowledged = false; let observation = 'unknown';
    try {
      const deleted = await deadline(() => storage.delete(claim.storageKey, { timeoutMs }), timeoutMs);
      deleteAcknowledged = deleted?.acknowledged === true;
    } catch { /* unknown, not a successful deletion acknowledgement */ }
    try {
      const result = await deadline(() => storage.inspect(claim.storageKey, { timeoutMs }), timeoutMs);
      if (result?.found === true) observation = 'present';
      else if (result?.found === false) observation = 'absent';
    } catch { /* HTTP 403, network errors and malformed evidence are unknown */ }
    const recorded = await repository.recordCleanupObservation(claim, { deleteAcknowledged, observation }, timing);
    return { uploadId: claim.uploadId, kind: claim.kind, observation, deleteAcknowledged, recorded,
      permanentErasureConfirmed: false };
  }
  return {
    runOnce() {
      if (!accepting) return Promise.resolve(null);
      const operation = operate(); active.add(operation);
      operation.finally(() => active.delete(operation)).catch(() => {}); return operation;
    },
    async drain() { accepting = false; await Promise.allSettled([...active]); return { accepting: false, active: active.size }; },
  };
}
