import { createHash } from 'node:crypto';
import net from 'node:net';
import { PHOTO_EFFECTS } from '../photo-effects.js';
import { decodeImageDataUrl } from '../media-validation.js';
import { createPhotoHttpsTransport } from './qwen-provider.js';

// Local reuse adapter only: not included in the production build or wired into
// candidate/lifecycle admission. These are the existing seededit.js defaults,
// not a claim that a current account can use this model or that effects passed.
export const ORIGINAL_SEEDREAM_PROVIDER = 'volc-seedream';
export const ORIGINAL_SEEDREAM_MODEL = 'doubao-seedream-4-0-250828';
const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const apiHost = 'ark.cn-beijing.volces.com';
const inputLimit = 2 * 1024 * 1024, outputLimit = 20 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const unknown = code => Object.assign(fail(code), { outcome: 'unknown', retryAllowed: false });
const sha = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const parameters = Object.freeze(Object.fromEntries(Object.values(PHOTO_EFFECTS)
  .filter(effect => effect.type === 'generative').map(effect => [effect.id, Object.freeze({
    prompt: effect.prompt, size: '2k', responseFormat: 'url', watermark: true,
  })])));
export const ORIGINAL_SEEDREAM_EFFECT_IDS = Object.freeze(Object.keys(parameters));

/** Parameter definition, not an enabled/approved catalog entry. Keep original
 * IDs/prompts; do not alias dedicated restoration/age models to this adapter. */
export function originalSeedreamEffectParameters(effectId) {
  return Object.hasOwn(parameters, effectId) ? { ...parameters[effectId] } : null;
}

function exactHosts(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32 || new Set(value).size !== value.length
    || value.some(host => typeof host !== 'string' || host.length > 253 || !host.includes('.') || net.isIP(host)
      || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
    throw fail('PHOTO_SEEDREAM_HOST_POLICY_REQUIRED');
  }
  return Object.freeze([...value]);
}

function checkedUrl(value, allowed) {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[^\x21-\x7e]|\\/.test(value)) {
    throw fail('PHOTO_SEEDREAM_URL_REJECTED');
  }
  let url;
  try { url = new URL(value); } catch { throw fail('PHOTO_SEEDREAM_URL_REJECTED'); }
  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  if (authority !== url.hostname || !allowed.includes(url.hostname) || url.port || url.username || url.password || url.hash) {
    throw fail('PHOTO_SEEDREAM_URL_REJECTED');
  }
  return url;
}

function image(value, limit, source = false) {
  if (!Buffer.isBuffer(value?.bytes) || value.bytes.length < 16 || value.bytes.length > limit
    || !imageTypes.has(value.contentType)) throw fail('PHOTO_SEEDREAM_IMAGE_REJECTED');
  const bytes = Buffer.from(value.bytes), contentType = value.contentType;
  if (value.byteLength !== bytes.length || value.sha256 !== sha(bytes)) throw fail('PHOTO_SEEDREAM_IMAGE_REJECTED');
  try {
    const info = decodeImageDataUrl(`data:${contentType};base64,${bytes.toString('base64')}`,
      { maxBytes: limit, maxSide: 8192, maxPixels: source ? 36_000_000 : 40_000_000 });
    if (source && (info.width <= 14 || info.height <= 14 || info.width > info.height * 16 || info.height > info.width * 16)) {
      throw new Error();
    }
  }
  catch { throw fail('PHOTO_SEEDREAM_IMAGE_REJECTED'); }
  return { bytes, contentType, byteLength: bytes.length, sha256: sha(bytes) };
}

/** Request/response core for future photo-jobs integration. The caller must
 * journal one dispatch and enforce current ownership/consent first. This is
 * not wired into the existing Qwen-only lifecycle/production build.
 *
 * Official image API supports data URIs for Seedream 4.0. Use verified bytes
 * directly: no source URL, additional upload, signer or public input object.
 * https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh
 * Result hosts remain explicit server configuration, never inferred from user
 * input or a provider response.
 *
 * Preserve requestId ONLY from the transport's validated X-Request-Id response
 * header (Ark SDK SERVER_REQUEST_HEADER). Neither the SDK's X-Client-Request-Id
 * nor a local digest substitutes for it. Missing/invalid IDs explicitly leave
 * an incomplete receipt: the current repository must reject it, without replay.
 * responseFingerprint is a separate local digest, not a supplier reference.
 * No environment reads, network-on-import, automatic retry or fallback. */
export function createOriginalSeedreamPhotoAdapter({ apiKey, resultHosts,
  transport = createPhotoHttpsTransport(), timeoutMs = 120_000 } = {}) {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(apiKey)
    || typeof transport !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) {
    throw fail('PHOTO_SEEDREAM_CONFIG_REQUIRED');
  }
  const results = exactHosts(resultHosts);
  return {
    async generate({ input, spec } = {}) {
      let frozen;
      try { frozen = structuredClone(spec); } catch { throw fail('PHOTO_SEEDREAM_SPEC_REJECTED'); }
      const p = frozen?.effectParameters, expected = originalSeedreamEffectParameters(frozen?.effectId);
      if (frozen?.provider !== ORIGINAL_SEEDREAM_PROVIDER || frozen?.model !== ORIGINAL_SEEDREAM_MODEL
        || !identifier(frozen?.inputAssetId) || !identifier(frozen?.effectVersion)
        || frozen?.purpose !== `photo-effect:${frozen?.effectId}` || !expected || !p
        || Object.keys(p).length !== Object.keys(expected).length
        || !Object.keys(expected).every(key => Object.hasOwn(p, key) && p[key] === expected[key])) {
        throw fail('PHOTO_SEEDREAM_SPEC_REJECTED');
      }
      const original = image(input, inputLimit, true);
      const source = `data:${original.contentType};base64,${original.bytes.toString('base64')}`;
      // Preserve legacy model/prompt/size/watermark fields. Only input transport
      // changes to the official data URI form; do not add guessed parameters.
      const body = Buffer.from(JSON.stringify({ model: ORIGINAL_SEEDREAM_MODEL, prompt: p.prompt,
        image: source, response_format: p.responseFormat, size: p.size, watermark: p.watermark }));
      let response;
      try { response = await transport({ url: endpoint, allowedHosts: [apiHost], method: 'POST', body,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeoutMs, maxBytes: 1024 * 1024 }); }
      catch { throw unknown('PHOTO_SEEDREAM_OUTCOME_UNCONFIRMED'); }
      if (response?.status !== 200 || response.contentType !== 'application/json' || !Buffer.isBuffer(response.bytes)
        || !response.bytes.length || response.bytes.length > 1024 * 1024) throw unknown('PHOTO_SEEDREAM_OUTCOME_UNCONFIRMED');
      const responseBytes = Buffer.from(response.bytes);
      let value, url;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(responseBytes));
        if (!value || value.error || !Array.isArray(value.data) || value.data.length !== 1 || value.data[0]?.error
          || (value.model !== undefined && value.model !== ORIGINAL_SEEDREAM_MODEL)) throw new Error();
        url = checkedUrl(value.data[0]?.url, results).toString();
      } catch { throw unknown('PHOTO_SEEDREAM_RESPONSE_UNCONFIRMED'); }
      const requestId = response.serverRequestId;
      const verifiedId = typeof requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId);
      return { provider: ORIGINAL_SEEDREAM_PROVIDER, model: ORIGINAL_SEEDREAM_MODEL, url,
        responseFingerprint: sha(responseBytes), ...(verifiedId
          ? { requestId, requestIdSource: 'response-header:x-request-id' }
          : { receiptIncomplete: true, integrationGap: 'supplier-request-id-unconfirmed' }) };
    },
    async readGenerated({ url } = {}) {
      const parsed = checkedUrl(url, results);
      let response;
      try { response = await transport({ url: parsed.toString(), allowedHosts: [parsed.hostname], method: 'GET',
        headers: { Accept: 'image/png, image/jpeg, image/webp' }, timeoutMs: 30_000, maxBytes: outputLimit }); }
      catch { throw unknown('PHOTO_SEEDREAM_OUTPUT_UNCONFIRMED'); }
      if (response?.status !== 200 || !Buffer.isBuffer(response.bytes)) throw unknown('PHOTO_SEEDREAM_OUTPUT_UNCONFIRMED');
      try { return image({ bytes: response.bytes, byteLength: response.bytes.length, contentType: response.contentType,
        sha256: sha(response.bytes) }, outputLimit); }
      catch { throw unknown('PHOTO_SEEDREAM_OUTPUT_UNCONFIRMED'); }
    },
  };
}
