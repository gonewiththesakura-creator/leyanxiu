import { bodyLimit } from 'hono/body-limit';
import { isIP } from 'node:net';

const fail = code => Object.assign(new Error(code), { code });
const identifier = (value, max = 128) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const errors = new Map([
  ['PHOTO_CONTEXT_ACCOUNT_REQUIRED', [401, 'XPAY_WECHAT_LOGIN_REQUIRED']],
  ['PHOTO_JOB_NOT_AUTHORIZED', [403, 'PHOTO_JOB_NOT_AUTHORIZED']],
  ['STALE_CONSENT_VERSION', [409, 'STALE_CONSENT_VERSION']],
  ['PHOTO_ASSET_NOT_FOUND', [404, 'PHOTO_ASSET_NOT_FOUND']],
]);
const ext = type => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[type];
const publicAsset = asset => ({ assetId: asset.assetId, kind: 'image', createdAt: asset.createdAt,
  expiresAt: asset.expiresAt, contentType: asset.contentType, ext: ext(asset.contentType) });
const sameAsset = (a, b) => a && b && a.assetId === b.assetId && a.storageKey === b.storageKey
  && a.sha256 === b.sha256 && a.expiresAt === b.expiresAt && a.contentType === b.contentType;

/** Native-channel composition only. Mount before (or instead of) legacy routes
 * with the same paths. Authentication must use the persistent WeChat identity.
 * sign is a trusted, private-object signing port, never a client-supplied URL.
 * Already issued URLs can remain usable until their bounded expiry; SQL
 * revocation blocks new URLs immediately but does not claim physical erasure.
 */
export function registerNativePhotoRoutes(app, { authenticated, context, ready, mediaUrl, now = Date.now }) {
  const maxAgeMs = mediaUrl?.maxAgeMs ?? 60000;
  const hosts = new Set(mediaUrl?.allowedHosts || []);
  if (!app || !context || typeof authenticated !== 'function' || typeof ready !== 'function'
    || typeof mediaUrl?.sign !== 'function' || !hosts.size || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 60000
    || [...hosts].some(host => typeof host !== 'string' || host !== host.toLowerCase() || isIP(host)
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(host))) {
    throw fail('PHOTO_NATIVE_ROUTE_DEPENDENCIES_REQUIRED');
  }
  const sign = mediaUrl.sign.bind(mediaUrl);
  const resolve = typeof context === 'function' ? context : () => context;
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('PHOTO_NATIVE_TIME_INVALID'); return value; };
  const protect = handler => async c => {
    c.header('Cache-Control', 'private, no-store');
    try {
      const identity = await authenticated(c);
      if (identity?.response) return identity.response;
      if (identity?.auth?.authMethod !== 'wechat' || !identifier(identity.auth.userId, 80)) return c.json({ code: 'XPAY_WECHAT_LOGIN_REQUIRED' }, 401);
      return await handler(c, identity.auth.userId, await resolve());
    } catch (error) {
      const [status, code] = errors.get(error?.code || error?.message) || [503, 'PHOTO_NATIVE_UNCONFIRMED'];
      return c.json({ code, message: '处理结果尚未确认，请刷新核实。' }, status);
    }
  };
  const signAsset = async (current, userId, assetId) => {
    const asset = await current.readOwnedAsset(userId, assetId);
    if (!asset) throw fail('PHOTO_ASSET_NOT_FOUND');
    const deadline = Math.min(asset.expiresAt, time() + maxAgeMs);
    if (deadline <= time()) throw fail('PHOTO_ASSET_NOT_FOUND');
    const signed = await sign({ userId, assetId, storageKey: asset.storageKey, sha256: asset.sha256, expiresAt: deadline });
    // Snapshot the port result once; do not validate a getter then serialize it again.
    const receipt = { assetId: signed?.assetId, url: signed?.url, expiresAt: signed?.expiresAt };
    let url;
    try { url = new URL(receipt.url); } catch { throw fail('PHOTO_MEDIA_URL_UNCONFIRMED'); }
    if (receipt.assetId !== assetId || typeof receipt.url !== 'string' || receipt.url.length > 8192
      || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !hosts.has(url.hostname)
      || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= time() || receipt.expiresAt > deadline) throw fail('PHOTO_MEDIA_URL_UNCONFIRMED');
    // Signing can await remote work. A concurrent withdrawal/deletion/expiry
    // must win before a newly generated link is returned to the client.
    if (!sameAsset(asset, await current.readOwnedAsset(userId, assetId))) throw fail('PHOTO_ASSET_NOT_FOUND');
    if (receipt.expiresAt <= time()) throw fail('PHOTO_MEDIA_URL_UNCONFIRMED');
    return { ...publicAsset(asset), url: receipt.url, urlExpiresAt: receipt.expiresAt };
  };
  const invalid = c => c.json({ code: 'PHOTO_NATIVE_INVALID_REQUEST' }, 400);
  const partial = (c, data) => c.json({ code: 'ERASURE_PARTIAL',
    message: '访问权限已撤销，存储及供应商副本的删除仍待确认。',
    // These routes persist access revocation only. A separate cleanup worker
    // must confirm its own durable intent before reporting deletion scheduled.
    data: { ...data, accessRevoked: true, deletionScheduled: false, physicalDeletion: 'pending',
      supplierPending: [{ status: 'pending' }] } }, 202);
  const limit = () => bodyLimit({ maxSize: 1024, onError: c => c.json({ code: 'PHOTO_NATIVE_INVALID_REQUEST' }, 413) });
  app.use('/api/consents', limit());
  app.use('/api/consents/:type/withdraw', limit());
  app.get('/api/consents', protect(async (c, userId, current) => c.json({ code: 0, data: await current.readConsents(userId) })));
  app.post('/api/consents', protect(async (c, userId, current) => {
    const body = await c.req.json().catch(() => null);
    if (!body || Array.isArray(body) || !['basic', 'face_processing'].includes(body.consentType) || body.action !== 'granted') return invalid(c);
    const fields = body.consentType === 'basic' ? 'action,consentType,version' : 'action,consentType,subjectAuthorization,version';
    if (Object.keys(body).sort().join(',') !== fields || !identifier(body.version, 80)
      || (body.consentType === 'face_processing' && !['self', 'authorized'].includes(body.subjectAuthorization))) return invalid(c);
    const versions = (await current.readConsents(userId)).current;
    if (body.version !== versions[body.consentType]) throw fail('STALE_CONSENT_VERSION');
    if ((await ready(userId))?.ready !== true) return c.json({ code: 'PHOTO_NATIVE_NOT_AVAILABLE' }, 503);
    if (body.consentType === 'basic') await current.grantBasicConsent(userId, body.version);
    else await current.grantFaceConsent(userId, { version: body.version, subjectAuthorization: body.subjectAuthorization });
    return c.json({ code: 0, data: { consentType: body.consentType, version: body.version, action: 'granted' } });
  }));
  app.post('/api/consents/:type/withdraw', protect(async (c, userId, current) => {
    const type = c.req.param('type');
    if (!['basic', 'face_processing'].includes(type)) return invalid(c);
    const text = await c.req.text();
    if (text.trim()) { let body; try { body = JSON.parse(text); } catch { return invalid(c); }
      if (!body || Array.isArray(body) || Object.keys(body).length) return invalid(c); }
    const version = (await current.readConsents(userId)).current[type];
    if (type === 'basic') await current.withdrawBasicConsent(userId);
    else await current.withdrawFaceConsent(userId);
    return partial(c, { consent: { consentType: type, version, action: 'withdrawn' } });
  }));
  app.get('/api/assets/:id/url', protect(async (c, userId, current) => {
    const id = c.req.param('id'); if (!identifier(id)) return invalid(c);
    return c.json({ code: 0, data: await signAsset(current, userId, id) });
  }));
  app.delete('/api/assets/:id', protect(async (c, userId, current) => {
    const id = c.req.param('id'); if (!identifier(id)) return invalid(c);
    const deleted = await current.deleteAsset(userId, id);
    if (!deleted) throw fail('PHOTO_ASSET_NOT_FOUND');
    // "deleted" is the existing client's visibility acknowledgement. Keep
    // physical erasure explicitly pending and omit the internal storage key.
    return partial(c, { assetId: id, deleted: true });
  }));
  app.get('/api/works', protect(async (c, userId, current) => {
    const works = await current.listWorks(userId);
    const signed = [];
    for (const work of works) {
      try { signed.push(await signAsset(current, userId, work.assetId)); }
      catch (error) { if (error?.code !== 'PHOTO_ASSET_NOT_FOUND') throw error; }
    }
    // A later signing await must not re-expose an earlier item revoked meanwhile.
    const remaining = new Map((await current.listWorks(userId)).map(work => [work.assetId, work]));
    return c.json({ code: 0, data: signed.filter(work => remaining.get(work.assetId)?.expiresAt === work.expiresAt
      && work.urlExpiresAt > time()) });
  }));
}
