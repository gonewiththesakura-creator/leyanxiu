import { createHash } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = new Set(['image/jpeg', 'image/png', 'image/webp']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const sourceKey = key => /^private\/mini-photo-input\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(key || '');
const outputKey = key => /^private\/photo-outputs\/[a-f0-9]{32}\.(jpg|png|webp)$/.test(key || '');
const inputLimit = 2 * 1024 * 1024, outputLimit = 20 * 1024 * 1024;
function media(value, max = outputLimit) {
  const original = value?.bytes, contentType = value?.contentType, byteLength = value?.byteLength, sha256 = value?.sha256;
  if (!Buffer.isBuffer(original) || original.length < 16 || original.length > max) throw fail('PHOTO_MEDIA_BYTES_UNCONFIRMED');
  const bytes = Buffer.from(original);
  if (!mime.has(contentType) || byteLength !== bytes.length || sha256 !== digest(bytes)) throw fail('PHOTO_MEDIA_BYTES_UNCONFIRMED');
  return { bytes, contentType, byteLength, sha256 };
}
const ownedSnapshot = value => value && ({ assetId: value.assetId, assetKind: value.assetKind, storageKey: value.storageKey,
  sha256: value.sha256, byteLength: value.byteLength, contentType: value.contentType, expiresAt: value.expiresAt });
const sameOwned = (a, b) => a && b && Object.keys(a).every(key => a[key] === b[key]);

/** Adapter ports for the journaled generation pipeline. No URLs are issued for
 * source photos; identity, current consent and expiry come only from context.
 * Cloning prevents caller-owned input mutation across asynchronous operations.
 * Provider/marker implementations remain responsible for their real transport,
 * decode, watermark verification and bounded execution. No automatic retries.
 */
export function createPhotoMediaPorts({ context, inputStorage, outputStorage, provider, marker, moderator, storageTimeoutMs = 10000 } = {}) {
  if (typeof context?.readOwnedAsset !== 'function' || typeof inputStorage?.read !== 'function'
    || !['put', 'read'].every(name => typeof outputStorage?.[name] === 'function')
    || !['generate', 'readGenerated'].every(name => typeof provider?.[name] === 'function')
    || typeof marker?.mark !== 'function' || typeof moderator?.moderate !== 'function'
    || !Number.isSafeInteger(storageTimeoutMs) || storageTimeoutMs < 10 || storageTimeoutMs > 60000) throw fail('PHOTO_MEDIA_PORTS_REQUIRED');
  // Capture the trusted adapters once instead of following later replacements.
  const owned = context.readOwnedAsset.bind(context), inputRead = inputStorage.read.bind(inputStorage);
  const generate = provider.generate.bind(provider), generatedRead = provider.readGenerated.bind(provider);
  const mark = marker.mark.bind(marker), moderate = moderator.moderate.bind(moderator);
  const put = outputStorage.put.bind(outputStorage), read = outputStorage.read.bind(outputStorage);
  return {
    async readInput(value = {}) {
      const userId = value.userId, assetId = value.assetId;
      if (!identifier(userId) || !identifier(assetId)) throw fail('PHOTO_MEDIA_INPUT_NOT_AUTHORIZED');
      const before = ownedSnapshot(await owned(userId, assetId));
      // kind:'image' is a display field, not proof of input ownership. The
      // context's internal assetKind is the actual persisted input/output kind.
      if (!before || before.assetId !== assetId || before.assetKind !== 'input' || !sourceKey(before.storageKey)
        || !Number.isSafeInteger(before.byteLength) || before.byteLength < 16 || before.byteLength > inputLimit
        || !mime.has(before.contentType) || !/^[a-f0-9]{64}$/.test(before.sha256 || '')) throw fail('PHOTO_MEDIA_INPUT_NOT_AUTHORIZED');
      let result;
      try { result = await inputRead(before.storageKey, { timeoutMs: storageTimeoutMs }); }
      catch { throw fail('PHOTO_MEDIA_INPUT_UNCONFIRMED'); }
      if (result?.found !== true) throw fail('PHOTO_MEDIA_INPUT_UNCONFIRMED');
      const image = media(result, inputLimit);
      if (image.sha256 !== before.sha256 || image.byteLength !== before.byteLength || image.contentType !== before.contentType) throw fail('PHOTO_MEDIA_INPUT_UNCONFIRMED');
      if (!sameOwned(before, ownedSnapshot(await owned(userId, assetId)))) throw fail('PHOTO_MEDIA_INPUT_NOT_AUTHORIZED');
      return image;
    },
    async generate(value = {}) {
      const input = media(value.input, inputLimit); let spec;
      try { spec = structuredClone(value.spec); } catch { throw fail('PHOTO_MEDIA_SPEC_UNCONFIRMED'); }
      return generate({ input, spec });
    },
    async readGenerated(value = {}) {
      const url = value.url;
      return media(await generatedRead({ url }));
    },
    async mark(value = {}) {
      const input = media(value), contentId = value.contentId, operation = value.operation, labelVersion = value.labelVersion;
      if (!identifier(contentId) || !identifier(labelVersion) || !['edit', 'generate'].includes(operation)) throw fail('PHOTO_MEDIA_MARK_UNCONFIRMED');
      const marked = await mark({ ...input, contentId, operation, labelVersion });
      const proof = { verified: marked?.verified, contentId: marked?.contentId, operation: marked?.operation, labelVersion: marked?.labelVersion };
      if (proof.verified !== true || proof.contentId !== contentId || proof.operation !== operation || proof.labelVersion !== labelVersion) throw fail('PHOTO_MEDIA_MARK_UNCONFIRMED');
      return { ...media(marked), ...proof };
    },
    output: {
      async put(value = {}) {
        const key = value.key, original = value.bytes, contentType = value.contentType;
        if (!outputKey(key) || !Buffer.isBuffer(original) || original.length < 16 || original.length > outputLimit || !mime.has(contentType)) throw fail('PHOTO_MEDIA_OUTPUT_INVALID');
        const bytes = Buffer.from(original);
        return put(key, bytes, { contentType, timeoutMs: storageTimeoutMs });
      },
      async read(value = {}) {
        const key = value.key;
        const expected = { sha256: value.expected?.sha256, byteLength: value.expected?.byteLength, contentType: value.expected?.contentType };
        if (!outputKey(key) || !/^[a-f0-9]{64}$/.test(expected.sha256 || '') || !Number.isSafeInteger(expected.byteLength)
          || expected.byteLength < 16 || expected.byteLength > outputLimit || !mime.has(expected.contentType)) throw fail('PHOTO_MEDIA_OUTPUT_INVALID');
        const result = await read(key, { expected: { ...expected }, timeoutMs: storageTimeoutMs });
        if (result?.found === false) return { found: false };
        if (result?.found !== true) throw fail('PHOTO_MEDIA_OUTPUT_UNCONFIRMED');
        const image = media(result);
        if (image.sha256 !== expected.sha256 || image.byteLength !== expected.byteLength || image.contentType !== expected.contentType) throw fail('PHOTO_MEDIA_OUTPUT_UNCONFIRMED');
        return { found: true, ...image };
      },
    },
    moderator: {
      async moderate(value = {}) {
        const original = value.bytes, contentType = value.contentType, direction = value.direction, journal = value.journal;
        if (!Buffer.isBuffer(original) || original.length < 16 || original.length > outputLimit || !mime.has(contentType)
          || direction !== 'output' || typeof journal !== 'function') throw fail('PHOTO_MEDIA_REVIEW_INVALID');
        return moderate({ bytes: Buffer.from(original), contentType, direction, journal });
      },
    },
  };
}
