// The original product catalog describes what can be browsed. It is not a
// provider allowlist, a price list, or evidence that creation is available.
// Stable effect ID comes from the checked-in approvedEffects policy. Its
// version is a distinct server-owned field. An ID binding grants no readiness.
const photoEffectBindings = Object.freeze({
  'natural-avatar': 'natural-avatar',
  'modern-comic': 'modern-comic',
  'gentle-watercolor': 'gentle-watercolor',
});
const photoSubtitles = Object.freeze({
  'natural-avatar': '自然柔光与简洁背景；AI 结果的人物细节可能改变',
  'modern-comic': '明快线条与自然色彩；AI 漫画的人物细节可能改变',
  'gentle-watercolor': '柔和笔触与纸张肌理；AI 水彩的人物细节可能改变',
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (message, code) => Object.assign(new Error(message), { code });

function resolvePhotoEffectId(localId) {
  return typeof localId === 'string' && own(photoEffectBindings, localId) ? photoEffectBindings[localId] : null;
}

function photoSelection(localId, snapshot) {
  const serviceEffectId = resolvePhotoEffectId(localId);
  const matches = serviceEffectId && Array.isArray(snapshot?.effects)
    ? snapshot.effects.filter(effect => effect?.id === serviceEffectId) : [];
  // A creation snapshot comes from creationClient.refresh(), which already
  // checks disclosure, protocols and server capabilities. Conflicting duplicate
  // entries cannot authorize an effect, and local enabled flags grant nothing.
  const canCreate = Boolean(serviceEffectId && snapshot?.available === true && matches.length === 1
    && matches[0].included === true && matches[0].available === true);
  return { productEffectId: typeof localId === 'string' ? localId : '', serviceEffectId,
    canCreate, available: canCreate, availabilityLabel: canCreate ? '可制作' : '暂未开放' };
}

function photoCards(localEffects, snapshot) {
  return (Array.isArray(localEffects) ? localEffects : []).map(effect => {
    const selection = photoSelection(effect?.id, snapshot);
    const enabled = effect?.enabled !== false;
    const canCreate = enabled && selection.canCreate;
    return { ...effect, ...selection, canCreate, available: canCreate,
      availabilityLabel: canCreate ? '可制作' : '暂未开放',
      ...(typeof effect?.id === 'string' && own(photoSubtitles, effect.id)
        ? { subtitle: photoSubtitles[effect.id] } : {}) };
  });
}

function videoCards(templates) {
  // The legacy video routes have no native durable-job contract yet. A public
  // preview or historical provider test must not silently enable charging.
  return (Array.isArray(templates) ? templates : []).map(template => ({ ...template,
    canCreate: false, available: false, availabilityLabel: '模板预览 · 创作暂未开放' }));
}

async function generateSelectedPhoto(client, input, onStage) {
  const selectedEffectId = input?.effectId, image = input?.image, consent = input?.consent;
  const serviceEffectId = resolvePhotoEffectId(selectedEffectId);
  if (!serviceEffectId) throw fail('这个效果暂未开放制作', 'CREATION_NOT_AVAILABLE');
  if (!client || typeof client.generate !== 'function' || typeof client.refresh !== 'function') {
    throw fail('创作服务尚未连接，请刷新后重试', 'CREATION_NOT_AVAILABLE');
  }
  // Recheck exact inclusion and reject conflicting duplicates even if a stale
  // card looked ready. The creation client then performs its own account and
  // durable pending-work checks before uploading.
  const snapshot = await client.refresh();
  if (!photoSelection(selectedEffectId, snapshot).canCreate) throw fail('这个效果暂未开放制作', 'CREATION_NOT_AVAILABLE');
  // Preserve the selected effect, consent and image; never choose the first
  // available effect. Existing client rechecks server facts before any upload,
  // owns account-bound idempotency, and never calls a payment API itself.
  return client.generate({ image, effectId: serviceEffectId, consent }, onStage);
}

module.exports = { resolvePhotoEffectId, photoSelection, photoCards, videoCards, generateSelectedPhoto };
