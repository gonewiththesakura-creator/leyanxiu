import { bodyLimit } from 'hono/body-limit';

export const photoUploadProtocol = 'photo-uploads-v1';
const errors = new Map([
  ['PHOTO_UPLOAD_INVALID_REQUEST', [400, 'PHOTO_UPLOAD_INVALID_REQUEST']],
  ['PHOTO_UPLOAD_NOT_AUTHORIZED', [403, 'PHOTO_UPLOAD_NOT_AUTHORIZED']],
  ['PHOTO_UPLOAD_ACCOUNT_REQUIRED', [401, 'XPAY_WECHAT_LOGIN_REQUIRED']],
  ['PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT', [409, 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT']],
  ['PHOTO_UPLOAD_BUDGET_LIMIT', [429, 'PHOTO_UPLOAD_BUDGET_LIMIT']],
  ['PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE', [503, 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE']],
]);

/** Explicit mount only. Does not migrate, start a worker or call moderation. */
export function registerPhotoUploadRoutes(app, { service, authenticated, readiness }) {
  if (!app || !service?.repository || typeof authenticated !== 'function' || typeof readiness !== 'function') throw new Error('PHOTO_UPLOAD_DEPENDENCIES_REQUIRED');
  const protect = handler => async c => {
    c.header('Cache-Control', 'private, no-store');
    try {
      const identity = await authenticated(c); if (identity?.response) return identity.response;
      if (identity?.auth?.authMethod !== 'wechat' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(identity?.auth?.userId || '')) return c.json({ code: 'XPAY_WECHAT_LOGIN_REQUIRED' }, 401);
      return await handler(c, identity.auth.userId);
    } catch (error) {
      const [status, code] = errors.get(error?.code || error?.message) || [503, 'PHOTO_UPLOAD_UNCONFIRMED'];
      return c.json({ code, message: code === 'PHOTO_UPLOAD_BUDGET_LIMIT'
        ? '今日照片上传审核数量已达上限，本次未创建上传，请稍后再试。'
        : code === 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' ? '本次照片处理未完成，请查询原上传状态，勿重复提交。'
        : code === 'PHOTO_UPLOAD_INVALID_REQUEST' ? '照片格式或大小不支持，本次未创建上传，请更换照片。'
        : '请查询原上传状态，不要重复上传。' }, status);
    }
  };
  app.use('/api/mini/photo-uploads', bodyLimit({ maxSize: 2800100, onError: c => c.json({ code: 'PHOTO_UPLOAD_INVALID_REQUEST' }, 413) }));
  app.post('/api/mini/photo-uploads', protect(async (c, userId) => {
    const body = await c.req.json().catch(() => null); const key = c.req.header('idempotency-key');
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'image' || typeof body.image !== 'string' || !/^[a-f0-9]{32}$/.test(key || '')) return c.json({ code: 'PHOTO_UPLOAD_INVALID_REQUEST' }, 400);
    const previous = await service.repository.findOwnedByKey(userId, key);
    if (!previous && (await readiness(userId))?.ready !== true) return c.json({ code: 'PHOTO_UPLOAD_NOT_AVAILABLE' }, 503);
    const result = await service.submit({ userId, idempotencyKey: key, image: body.image });
    return c.json({ code: 0, data: result }, result.duplicate ? 200 : 202);
  }));
  app.get('/api/mini/photo-uploads/by-key/:key', protect(async (c, userId) => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('key'))) return c.json({ code: 'PHOTO_UPLOAD_INVALID_REQUEST' }, 400);
    return c.json({ code: 0, data: { upload: await service.repository.findOwnedByKey(userId, c.req.param('key')) } });
  }));
  app.get('/api/mini/photo-uploads/:id', protect(async (c, userId) => {
    if (!/^upload_[a-f0-9]{32}$/.test(c.req.param('id'))) return c.json({ code: 'PHOTO_UPLOAD_INVALID_REQUEST' }, 400);
    const upload = await service.repository.readOwned(userId, c.req.param('id'));
    return upload ? c.json({ code: 0, data: { upload } }) : c.json({ code: 'PHOTO_UPLOAD_NOT_FOUND' }, 404);
  }));
}
