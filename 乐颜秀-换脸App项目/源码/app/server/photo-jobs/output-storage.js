import { createHash } from 'node:crypto';
import OSS from 'ali-oss';

const MAX_BYTES = 20 * 1024 * 1024;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validKey = key => {
  const match = typeof key === 'string' && /^private\/photo-outputs\/[a-f0-9]{32}\.(jpg|png|webp)$/.exec(key);
  if (!match) throw fail('PHOTO_OUTPUT_STORAGE_KEY_INVALID');
  return MIME[match[1]];
};
const timeout = value => {
  const ms = value ?? 10_000;
  if (!Number.isSafeInteger(ms) || ms < 10 || ms > 60_000) throw fail('PHOTO_OUTPUT_STORAGE_TIMEOUT_INVALID');
  return ms;
};
const contentType = headers => String(headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
const versioned = headers => Boolean(headers?.['x-oss-version-id'] && headers['x-oss-version-id'] !== 'null');
const notFound = error => error?.code === 'NoSuchKey' && error?.status === 404;
function expectedValue(key, value) {
  const expected = { sha256: value?.sha256, byteLength: value?.byteLength, contentType: value?.contentType };
  if (!/^[a-f0-9]{64}$/.test(expected.sha256 || '') || !Number.isSafeInteger(expected.byteLength)
    || expected.byteLength < 16 || expected.byteLength > MAX_BYTES || expected.contentType !== validKey(key)) {
    throw fail('PHOTO_OUTPUT_STORAGE_EXPECTED_REQUIRED');
  }
  return expected;
}
function validateBytes(key, bytes, type) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_BYTES || type !== validKey(key)) throw fail('PHOTO_OUTPUT_STORAGE_IMAGE_INVALID');
  const matches = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!matches) throw fail('PHOTO_OUTPUT_STORAGE_IMAGE_INVALID');
  return { contentType: type, byteLength: bytes.length, sha256: hash(bytes) };
}
function metadataMatches(headers, expected) {
  return Number(headers?.['content-length']) === expected.byteLength && contentType(headers) === expected.contentType
    && headers?.['x-oss-meta-sha256'] === expected.sha256
    && (!headers?.['content-encoding'] || headers['content-encoding'] === 'identity');
}

/** Object bytes only, never an ownership/consent/marking/moderation authority.
 * The caller must authorise using the shared context, durably record PUT/cleanup
 * intent, decode and mark the image, and bind the final bytes to an output review.
 * Container signatures here prevent MIME confusion; they do NOT prove a full
 * image decode, visible AI label, valid XMP or a passing moderation result.
 * No metadata index, network on construction, default credentials or retries.
 */
export function createPhotoOutputOssStorage({ credential, bucket, region, client, now = Date.now } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '') || !/^cn-[a-z]+(?:-[a-z]+)?$/.test(region || '')
    || typeof now !== 'function') throw fail('PHOTO_OUTPUT_STORAGE_CONFIG_REQUIRED');
  if (!client && (!credential?.accessKeyId || !credential?.accessKeySecret)) throw fail('PHOTO_OUTPUT_STORAGE_CREDENTIAL_REQUIRED');
  const sdk = client || new OSS({ accessKeyId: credential.accessKeyId, accessKeySecret: credential.accessKeySecret,
    ...(credential.securityToken ? { stsToken: credential.securityToken } : {}), bucket, region: `oss-${region}`, secure: true, retryMax: 0 });
  async function inspect(key, { timeoutMs } = {}) {
    validKey(key); const milliseconds = timeout(timeoutMs);
    try {
      const result = await sdk.head(key, { timeout: milliseconds });
      if (result?.res?.status !== 200) throw fail('PHOTO_OUTPUT_STORAGE_HEAD_UNCONFIRMED');
      return { found: true, versionHeaderPresent: versioned(result.res.headers) };
    } catch (error) {
      if (notFound(error)) return { found: false };
      throw fail('PHOTO_OUTPUT_STORAGE_HEAD_UNCONFIRMED');
    }
  }
  return {
    async put(key, bytes, { contentType: type, timeoutMs } = {}) {
      validKey(key); const milliseconds = timeout(timeoutMs);
      if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_BYTES) throw fail('PHOTO_OUTPUT_STORAGE_IMAGE_INVALID');
      const image = Buffer.from(bytes); // Freeze before the SDK's first await.
      const evidence = validateBytes(key, image, type);
      try {
        const response = await sdk.put(key, image, { timeout: milliseconds, headers: { 'Content-Type': type,
          'Cache-Control': 'private, no-store', 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
          'x-oss-meta-sha256': evidence.sha256 } });
        if (response?.res?.status !== 200) throw fail('PHOTO_OUTPUT_STORAGE_PUT_UNCONFIRMED');
        return { ...evidence, versionHeaderPresent: versioned(response.res.headers) };
      } catch { throw fail('PHOTO_OUTPUT_STORAGE_PUT_UNCONFIRMED'); }
    },
    async read(key, { expected: input, timeoutMs } = {}) {
      validKey(key); const expected = expectedValue(key, input); const milliseconds = timeout(timeoutMs);
      try {
        const head = await sdk.head(key, { timeout: milliseconds });
        const headers = head?.res?.headers;
        const etag = headers?.etag;
        if (head?.res?.status !== 200 || !metadataMatches(headers, expected) || typeof etag !== 'string'
          || etag.length > 128 || !/^"?[A-Za-z0-9-]+"?$/.test(etag)) throw fail('PHOTO_OUTPUT_STORAGE_INTEGRITY');
        const response = await sdk.get(key, { timeout: milliseconds, headers: { 'If-Match': etag, Range: `bytes=0-${expected.byteLength - 1}` } });
        if (![200, 206].includes(response?.res?.status) || !metadataMatches(response.res.headers, expected)
          || response.res.headers.etag !== etag) throw fail('PHOTO_OUTPUT_STORAGE_INTEGRITY');
        if (response.res.status === 206 && response.res.headers['content-range'] !== `bytes 0-${expected.byteLength - 1}/${expected.byteLength}`) throw fail('PHOTO_OUTPUT_STORAGE_INTEGRITY');
        const evidence = validateBytes(key, response.content, expected.contentType);
        if (evidence.sha256 !== expected.sha256 || evidence.byteLength !== expected.byteLength) throw fail('PHOTO_OUTPUT_STORAGE_INTEGRITY');
        return { found: true, bytes: response.content, ...evidence, versionHeaderPresent: versioned(response.res.headers) };
      } catch (error) {
        if (notFound(error)) return { found: false };
        throw fail('PHOTO_OUTPUT_STORAGE_READ_UNCONFIRMED');
      }
    },
    signedUrl(key, { ttlSeconds = 60, maxExpiresAt } = {}) {
      validKey(key);
      const stamp = now();
      if (!Number.isSafeInteger(stamp) || !Number.isSafeInteger(maxExpiresAt) || !Number.isSafeInteger(ttlSeconds)
        || ttlSeconds < 1 || ttlSeconds > 60) throw fail('PHOTO_OUTPUT_STORAGE_SIGNING_INVALID');
      // ali-oss 6.x uses utility.timestamp(), which rounds Date.now() to the
      // nearest second. Reserve fractional-second slack so a normal signature
      // never exceeds the caller's hard deadline by up to half a second.
      const deadline = Math.min(maxExpiresAt, stamp + ttlSeconds * 1000);
      const expires = Math.floor(deadline / 1000) - Math.ceil(stamp / 1000);
      if (expires < 1) throw fail('PHOTO_OUTPUT_STORAGE_EXPIRED');
      try {
        const value = sdk.signatureUrl(key, { method: 'GET', expires });
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== `${bucket}.oss-${region}.aliyuncs.com` || url.port
          || url.username || url.password || url.hash || url.pathname !== `/${key}` || !url.search || value.length > 2048) {
          throw fail('PHOTO_OUTPUT_STORAGE_SIGNING_UNCONFIRMED');
        }
        // Read the actual installed SDK signature deadline, never report a
        // separately guessed lifetime. Cross-second clock drift fails closed.
        const expiration = url.searchParams.getAll('Expires');
        const actualExpiry = Number(expiration[0]) * 1000;
        if (expiration.length !== 1 || !/^[0-9]+$/.test(expiration[0]) || !Number.isSafeInteger(actualExpiry)
          || actualExpiry <= stamp || actualExpiry > maxExpiresAt || actualExpiry > stamp + ttlSeconds * 1000) {
          throw fail('PHOTO_OUTPUT_STORAGE_SIGNING_UNCONFIRMED');
        }
        return { url: value, expiresAt: actualExpiry };
      } catch { throw fail('PHOTO_OUTPUT_STORAGE_SIGNING_UNCONFIRMED'); }
    },
    inspect,
    async delete(key, { timeoutMs } = {}) {
      validKey(key); const milliseconds = timeout(timeoutMs);
      let acknowledged = false; let observation = 'unknown'; let versionMarkerObserved = false;
      try {
        const response = await sdk.delete(key, { timeout: milliseconds });
        acknowledged = response?.res?.status === 204;
        versionMarkerObserved = versioned(response?.res?.headers) || response?.res?.headers?.['x-oss-delete-marker'] === 'true';
      } catch { /* A timeout is an unknown deletion, not a successful erase. */ }
      try {
        const result = await inspect(key, { timeoutMs: milliseconds });
        observation = result.found ? 'present' : 'absent';
        versionMarkerObserved ||= result.versionHeaderPresent === true;
      } catch { /* Retain unknown; caller must keep its durable cleanup duty. */ }
      return { acknowledged, observation, absentObserved: observation === 'absent', versionMarkerObserved,
        historyErasureVerified: false, lateWritesExcluded: false };
    },
  };
}
