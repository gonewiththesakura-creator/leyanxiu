import crypto from 'node:crypto';
import * as OpenApi from '@alicloud/openapi-client';
import * as TeaUtil from '@alicloud/tea-util';
import OSS from 'ali-oss';

// Official Green 2022-03-02 ImageModeration contract (checked 2026-10-09):
// https://help.aliyun.com/zh/document_detail/467829.html
// https://github.com/aliyun/alibabacloud-typescript-sdk/blob/master/green-20220302/src/client.ts
// Green accepts a URL/authorised OSS object, NOT an undocumented base64 field.
// Importing/constructing this module never uploads, enables a service or audits an image.
const REGIONS = new Set(['cn-shanghai', 'cn-hangzhou', 'cn-beijing', 'cn-shenzhen']);
const SERVICES = new Set(['baselineCheck', 'aigcCheck']);
const RISK = new Map([['none', 0], ['low', 1], ['medium', 2], ['high', 3]]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const fail = code => { throw new Error(code); };
const bounded = (value, fallback, minimum, maximum) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail('PHOTO_MODERATION_CONFIG_INVALID');
  return result;
};
function credentials(value) {
  if (!value || typeof value.accessKeyId !== 'string' || !value.accessKeyId.trim()
    || typeof value.accessKeySecret !== 'string' || !value.accessKeySecret.trim()) fail('PHOTO_MODERATION_CREDENTIALS_REQUIRED');
  return { accessKeyId: value.accessKeyId, accessKeySecret: value.accessKeySecret,
    ...(value.securityToken ? { securityToken: value.securityToken } : {}) };
}

export function createGreenImageTransport({ credential, region, client } = {}) {
  if (!REGIONS.has(region)) fail('PHOTO_MODERATION_REGION_INVALID');
  // An injected SDK-compatible client is a server/test dependency, never HTTP input.
  const sdk = client || new OpenApi.default.default(new OpenApi.default.Config({
    ...credentials(credential), regionId: region, endpoint: `green-cip.${region}.aliyuncs.com`,
  }));
  return async ({ service, serviceParameters, timeoutMs }) => sdk.callApi(new OpenApi.default.Params({
    action: 'ImageModeration', version: '2022-03-02', protocol: 'HTTPS', pathname: '/',
    method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
  }), new OpenApi.default.OpenApiRequest({ body: { Service: service, ServiceParameters: JSON.stringify(serviceParameters) } }),
  new TeaUtil.default.RuntimeOptions({ autoretry: false, maxAttempts: 1, connectTimeout: timeoutMs, readTimeout: timeoutMs }));
}

export function createOssModerationStorage({ credential, bucket, region, client } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket || '') || !REGIONS.has(region)) fail('PHOTO_MODERATION_STORAGE_INVALID');
  const sdk = client || new OSS({ ...credentials(credential), ...(credential?.securityToken ? { stsToken: credential.securityToken } : {}),
    bucket, region: `oss-${region}`, secure: true, retryMax: 0 });
  const validKey = key => {
    // Dedicated, immutable scratch objects; neither source assets nor the old JSON index.
    if (!/^private\/photo-moderation\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(key)) fail('PHOTO_MODERATION_STORAGE_KEY_INVALID');
  };
  return {
    async put(key, bytes, { contentType, timeoutMs }) {
      validKey(key);
      await sdk.put(key, bytes, { timeout: timeoutMs, headers: {
        'Content-Type': contentType, 'Cache-Control': 'private, no-store',
        'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true',
      } });
    },
    signedUrl(key, { ttlSeconds }) {
      validKey(key);
      const value = sdk.signatureUrl(key, { method: 'GET', expires: ttlSeconds });
      let url;
      try { url = new URL(value); } catch { fail('PHOTO_MODERATION_STORAGE_URL_INVALID'); }
      if (url.protocol !== 'https:' || url.hostname !== `${bucket}.oss-${region}.aliyuncs.com`
        || url.username || url.password || url.hash || url.port || decodeURIComponent(url.pathname) !== `/${key}`
        || !url.search || value.length > 2048) fail('PHOTO_MODERATION_STORAGE_URL_INVALID');
      return value;
    },
    async delete(key, { timeoutMs }) { validKey(key); await sdk.delete(key, { timeout: timeoutMs }); },
  };
}

function validateBytes(bytes, contentType, maximum) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > maximum) fail('PHOTO_MODERATION_IMAGE_INVALID');
  let extension;
  if (contentType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    extension = 'png';
    // Reject APNG; a static-image pass must not cover unaudited later frames.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (offset + 12 + length > bytes.length) fail('PHOTO_MODERATION_IMAGE_INVALID');
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') fail('PHOTO_MODERATION_ANIMATION_UNSUPPORTED');
      offset += length + 12;
    }
  } else if (contentType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8
    && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) extension = 'jpg';
  else if (contentType === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    extension = 'webp';
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + length > bytes.length) fail('PHOTO_MODERATION_IMAGE_INVALID');
      const chunk = bytes.toString('ascii', offset, offset + 4);
      if (['ANIM', 'ANMF'].includes(chunk) || (chunk === 'VP8X' && length >= 1 && (bytes[offset + 8] & 2))) fail('PHOTO_MODERATION_ANIMATION_UNSUPPORTED');
      offset += length + 8 + (length % 2);
    }
  }
  if (!extension) fail('PHOTO_MODERATION_IMAGE_INVALID');
  return extension;
}

async function deadline(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PHOTO_MODERATION_TIMEOUT')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function verdict(response, dataId, lowRisk) {
  const body = response?.body;
  const data = body?.Data;
  if (response?.statusCode !== 200 || body?.Code !== 200 || !identifier(body?.RequestId)
    || data?.DataId !== dataId || !RISK.has(data?.RiskLevel)
    || !Array.isArray(data?.Result) || !data.Result.length || data.Result.length > 100) fail('PHOTO_MODERATION_RESPONSE_UNCONFIRMED');
  const labels = data.Result.map(item => {
    if (!identifier(item?.Label) || (item.Confidence !== undefined
      && (!Number.isFinite(item.Confidence) || item.Confidence < 0 || item.Confidence > 100))
      || (item.RiskLevel !== undefined && (!RISK.has(item.RiskLevel) || RISK.get(item.RiskLevel) > RISK.get(data.RiskLevel)))
      || (data.RiskLevel === 'none' && !['nonLabel', 'nonLabel_lib'].includes(item.Label))) fail('PHOTO_MODERATION_RESPONSE_UNCONFIRMED');
    return { label: item.Label, ...(item.Confidence !== undefined ? { confidence: item.Confidence } : {}) };
  });
  if (data.ManualTaskId !== undefined && data.ManualTaskId !== null && data.ManualTaskId !== '' && !identifier(data.ManualTaskId)) fail('PHOTO_MODERATION_RESPONSE_UNCONFIRMED');
  const decision = data.RiskLevel === 'high' ? 'block'
    : data.ManualTaskId || data.RiskLevel === 'medium' ? 'review'
      : data.RiskLevel === 'low' ? lowRisk : 'allow';
  return { decision, requestId: body.RequestId, riskLevel: data.RiskLevel, labels };
}

/** Server-only assembly. Persist the receipt with the asset SHA before
 * registerInput/registerOutput. Never accept policy, services or receipts from
 * a client request. This module does not enable sales, count quota or retry.
 */
export function createPhotoImageModerator({ policy, transport, storage, credential, bucket, now = Date.now } = {}) {
  if (policy?.approved !== true || !identifier(policy.version) || !REGIONS.has(policy.region)
    || !SERVICES.has(policy.services?.input) || !SERVICES.has(policy.services?.output)
    || !['allow', 'review'].includes(policy.lowRisk)) fail('PHOTO_MODERATION_APPROVED_POLICY_REQUIRED');
  const config = { version: policy.version, region: policy.region, services: { ...policy.services }, lowRisk: policy.lowRisk,
    timeoutMs: bounded(policy.timeoutMs, 10_000, 10, 60_000),
    maxBytes: bounded(policy.maxBytes, 20 * 1024 * 1024, 16, 20 * 1024 * 1024) };
  const call = transport || createGreenImageTransport({ credential, region: config.region });
  const objects = storage || createOssModerationStorage({ credential, bucket, region: config.region });
  if (typeof call !== 'function' || !['put', 'signedUrl', 'delete'].every(key => typeof objects[key] === 'function')) fail('PHOTO_MODERATION_PORTS_REQUIRED');
  return {
    async moderate({ bytes, contentType, direction, journal } = {}) {
      if (!['input', 'output'].includes(direction)) fail('PHOTO_MODERATION_DIRECTION_INVALID');
      if (typeof journal !== 'function') fail('PHOTO_MODERATION_JOURNAL_REQUIRED');
      const ext = validateBytes(bytes, contentType, config.maxBytes);
      // Snapshot before any await; caller mutation cannot change audited bytes or policy.
      const image = Buffer.from(bytes);
      const sha256 = hash(image);
      const stagingId = crypto.randomUUID().replaceAll('-', '');
      const key = `private/photo-moderation/${stagingId}.${ext}`;
      const service = config.services[direction];
      const dataId = hash(JSON.stringify([sha256, direction, service, config.version, stagingId]));
      const binding = { provider: 'aliyun-green', policyVersion: config.version, service, direction, sha256, byteLength: image.length };
      // Persist deletion responsibility BEFORE any object write. A lost commit
      // response is not permission to write: let the caller reconcile its journal.
      // This port is server-owned and must commit to the shared durable store.
      const recorded = await journal({ reference: stagingId, extension: ext });
      if (recorded !== true) fail('PHOTO_MODERATION_JOURNAL_UNCONFIRMED');
      let result;
      let uploadConfirmed = false;
      let cleanupPending = false;
      try {
        await deadline(() => objects.put(key, image, { contentType, timeoutMs: config.timeoutMs }), config.timeoutMs);
        uploadConfirmed = true;
        const imageUrl = await deadline(() => objects.signedUrl(key, { ttlSeconds: 120 }), config.timeoutMs);
        // Even trusted injected storage cannot accidentally select non-HTTPS or credential URLs.
        let url;
        try { url = new URL(imageUrl); } catch { fail('PHOTO_MODERATION_SOURCE_UNCONFIRMED'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || imageUrl.length > 2048) fail('PHOTO_MODERATION_SOURCE_UNCONFIRMED');
        const response = await deadline(() => call({ service, serviceParameters: { imageUrl, dataId }, timeoutMs: config.timeoutMs }), config.timeoutMs);
        const confirmed = verdict(response, dataId, config.lowRisk);
        const checkedAt = now();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) fail('PHOTO_MODERATION_RESPONSE_UNCONFIRMED');
        result = { ...binding, ...confirmed, checkedAt,
          reference: `mod_${hash(JSON.stringify([binding, confirmed.requestId, dataId, confirmed.decision]))}` };
      } catch (error) {
        result = { ...binding, decision: 'unconfirmed', code: error?.message === 'PHOTO_MODERATION_TIMEOUT'
          ? 'PHOTO_MODERATION_TIMEOUT' : 'PHOTO_MODERATION_UNCONFIRMED' };
      } finally {
        try { await deadline(() => objects.delete(key, { timeoutMs: config.timeoutMs }), config.timeoutMs); }
        catch { cleanupPending = true; }
        // A timed-out/failed PUT may still complete after DELETE. Do not claim
        // deletion certainty; a durable lifecycle sweeper must revisit this key.
        if (!uploadConfirmed) cleanupPending = true;
      }
      return { ...result, cleanupPending, cleanupReference: stagingId, cleanupExtension: ext };
    },
  };
}
