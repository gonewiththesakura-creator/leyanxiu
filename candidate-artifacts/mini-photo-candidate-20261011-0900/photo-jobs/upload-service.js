import { createHash } from 'node:crypto';
import { parsePhotoUpload } from './upload-repository.js';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function bounded(operation, timeoutMs) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail('PHOTO_UPLOAD_STORAGE_UNCONFIRMED')), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
function verified(read) {
  if (read?.found !== true) return null;
  const bytes = Buffer.isBuffer(read.bytes) ? Buffer.from(read.bytes) : null;
  if (!bytes || bytes.length < 16 || bytes.length > 2097152 || read.byteLength !== bytes.length
    || read.sha256 !== hash(bytes) || !['image/png', 'image/jpeg', 'image/webp'].includes(read.contentType)) {
    throw fail('PHOTO_UPLOAD_STORAGE_UNCONFIRMED');
  }
  return { bytes, sha256: hash(bytes), byteLength: bytes.length, contentType: read.contentType };
}

export function createPhotoUploadService({ repository, storage, timeoutMs = 4000 }) {
  if (!repository?.submitIntent || !storage?.put || !storage?.read || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 10 || timeoutMs > 10000) throw fail('PHOTO_UPLOAD_DEPENDENCIES_REQUIRED');
  return {
    repository,
    async submit({ userId, idempotencyKey, image }) {
      const source = parsePhotoUpload(image);
      const result = await repository.submitIntent({ userId, idempotencyKey, ...source });
      if (result.duplicate) return result;
      // The durable intent already exists. Only its original caller may PUT.
      // A crash before PUT deliberately leaves staging; absence is not a retry permit.
      try {
        await bounded(async () => {
          await storage.put(result.storageKey, source.bytes, { contentType: source.contentType, timeoutMs });
          const read = verified(await storage.read(result.storageKey, { timeoutMs }));
          if (read) await repository.confirmStored(result.upload.id, read);
        }, timeoutMs);
      } catch { /* Recovery inspects the immutable key; it never repeats PUT. */ }
      const upload = await repository.readOwned(userId, result.upload.id);
      return { upload, duplicate: false };
    },
  };
}

/** One-shot worker. No timer, provider retry, claim lease or automatic re-review.
 * A failed DB receipt commit leaves claimed, which requires manual reconciliation.
 */
export function createPhotoUploadWorker({ repository, storage, moderator, timeoutMs = 4000 }) {
  if (!repository?.claimNext || !storage?.read || typeof moderator?.moderate !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) throw fail('PHOTO_UPLOAD_DEPENDENCIES_REQUIRED');
  let accepting = true;
  const active = new Set();
  async function operate() {
    const published = await repository.publishNext(); if (published) return published;
    if (!accepting) return null;
    const staging = await repository.nextStaging();
    if (staging) {
      try {
        const read = verified(await bounded(() => storage.read(staging.storage_key, { timeoutMs }), timeoutMs));
        // Missing or unconfirmed object stays staging, including across restarts.
        if (read) await repository.confirmStored(staging.id, read);
      } catch { /* no write/review retry */ }
    }
    if (!accepting) return null;
    const claimed = await repository.claimNext(); if (!claimed) return null;
    let receipt;
    try {
      const read = verified(await bounded(() => storage.read(claimed.storage_key, { timeoutMs }), timeoutMs));
      if (!read || read.sha256 !== claimed.sha256 || read.byteLength !== claimed.byte_length || read.contentType !== claimed.content_type) throw fail('PHOTO_UPLOAD_STORAGE_UNCONFIRMED');
      receipt = await moderator.moderate({ bytes: read.bytes, contentType: read.contentType, direction: 'input',
        journal: intent => repository.recordModerationIntent(claimed.id, intent) });
    } catch { receipt = { decision: 'unconfirmed' }; }
    await repository.recordReview(claimed.id, receipt);
    return await repository.publishNext() || repository.readOwned(claimed.user_id, claimed.id);
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
