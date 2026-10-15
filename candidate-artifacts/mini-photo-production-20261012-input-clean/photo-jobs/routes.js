import { bodyLimit } from 'hono/body-limit';

const identifier = (value, max = 128) => typeof value === 'string'
  && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const publicErrors = new Map([
  ['PHOTO_JOB_INVALID_SPEC', [400, 'PHOTO_JOB_INVALID_REQUEST']],
  ['PHOTO_JOB_NOT_AUTHORIZED', [403, 'PHOTO_JOB_NOT_AUTHORIZED']],
  ['PHOTO_CONTEXT_ACCOUNT_REQUIRED', [401, 'XPAY_WECHAT_LOGIN_REQUIRED']],
  ['PHOTO_JOB_ENTITLEMENT_REQUIRED', [402, 'PHOTO_JOB_ENTITLEMENT_REQUIRED']],
  // The canonical reservation port rejects before writing a reservation or job.
  // Commit/transport failures have different codes and must stay unconfirmed.
  ['XPAY_PROVIDER_BUDGET_LIMIT', [429, 'XPAY_PROVIDER_BUDGET_LIMIT']],
  ['PHOTO_JOB_IDEMPOTENCY_CONFLICT', [409, 'PHOTO_JOB_IDEMPOTENCY_CONFLICT']],
  ['EFFECT_DISABLED', [409, 'EFFECT_DISABLED']],
]);
export const photoJobProtocol = 'photo-jobs-v1';

/** Mount only after supplying the same persistent context used by consent,
 * upload, works and the worker. No provider call, migration or worker starts
 * inside this HTTP boundary. Readiness applies to NEW submissions only.
 */
export function registerPhotoJobRoutes(app, { context, authenticated, readiness }) {
  if (!app || !context || typeof authenticated !== 'function' || typeof readiness !== 'function') {
    throw new Error('PHOTO_JOB_ROUTE_DEPENDENCIES_REQUIRED');
  }
  const resolveContext = typeof context === 'function' ? context : () => context;
  const protect = handler => async c => {
    c.header('Cache-Control', 'private, no-store');
    try {
      const identity = await authenticated(c);
      if (identity?.response) return identity.response;
      if (identity?.auth?.authMethod !== 'wechat' || !identifier(identity.auth.userId, 80)) {
        return c.json({ code: 'XPAY_WECHAT_LOGIN_REQUIRED' }, 401);
      }
      return await handler(c, identity.auth.userId);
    } catch (error) {
      // A transport/commit failure cannot prove the transaction rolled back.
      // Never expose SQL, a storage key, provider response or raw stack trace.
      const [status, code] = publicErrors.get(error?.code || error?.message) || [503, 'PHOTO_JOB_UNCONFIRMED'];
      return c.json({ code, message: code === 'XPAY_PROVIDER_BUDGET_LIMIT'
        ? '今日制作额度已达到上限，本次未创建任务或扣除次数，请稍后再试。'
        : '制作状态尚未确认，请刷新原任务；不要重复制作。' }, status);
    }
  };
  app.use('/api/mini/photo-jobs', bodyLimit({ maxSize: 1024,
    onError: c => c.json({ code: 'PHOTO_JOB_INVALID_REQUEST' }, 413) }));
  app.post('/api/mini/photo-jobs', protect(async (c, userId) => {
    const body = await c.req.json().catch(() => null);
    const idempotencyKey = c.req.header('idempotency-key');
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'effectId,inputAssetId'
      || !identifier(body.effectId, 80) || !identifier(body.inputAssetId)
      || !/^[a-f0-9]{32}$/.test(idempotencyKey || '')) {
      return c.json({ code: 'PHOTO_JOB_INVALID_REQUEST' }, 400);
    }
    const current = await resolveContext();
    const previous = await current.repository.findOwnedByKey(userId, idempotencyKey);
    if (!previous) {
      const state = await readiness(userId);
      if (state?.ready !== true || !Array.isArray(state.photoEffectIds) || !state.photoEffectIds.includes(body.effectId)) {
        return c.json({ code: 'PHOTO_JOB_NOT_AVAILABLE', message: '这个图片效果暂未开放制作。' }, 503);
      }
    }
    // Only input/effect identifiers come from the client. Version, parameters,
    // provider, model, purpose and billing reference come from the frozen
    // server record. Existing keys retain that record after catalog changes.
    const specification = await current.submission({ userId, idempotencyKey,
      inputAssetId: body.inputAssetId, effectId: body.effectId });
    const result = await current.repository.submit(specification);
    return c.json({ code: 0, data: result }, result.duplicate ? 200 : 202);
  }));
  app.get('/api/mini/photo-jobs/by-key/:key', protect(async (c, userId) => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('key'))) return c.json({ code: 'PHOTO_JOB_INVALID_REQUEST' }, 400);
    const current = await resolveContext();
    // Null does not authorize a fresh paid submission: an earlier request may
    // still be committing. The native client keeps its original pending key.
    return c.json({ code: 0, data: { job: await current.repository.findOwnedByKey(userId, c.req.param('key')) } });
  }));
  app.get('/api/mini/photo-jobs/:id', protect(async (c, userId) => {
    if (!identifier(c.req.param('id'), 80)) return c.json({ code: 'PHOTO_JOB_INVALID_REQUEST' }, 400);
    const current = await resolveContext();
    const job = await current.repository.readOwned(userId, c.req.param('id'));
    return job ? c.json({ code: 0, data: { job } }) : c.json({ code: 'PHOTO_JOB_NOT_FOUND' }, 404);
  }));
}
