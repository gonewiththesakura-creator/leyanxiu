import { createHash } from 'node:crypto';
import { getPhotoEffect } from '../photo-effects.js';
import { QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER } from './qwen-provider.js';

export const originalEffectsProbeVersion = 'original-effects-v1-20261015';
export const originalEffectIds = Object.freeze([
  'classic-black-white', 'new-chinese', 'modern-comic', 'gentle-watercolor',
]);
export const originalEffectsInput = Object.freeze({
  inputKind: 'ai-generated-fictional-adult-portrait',
  workspaceRelativePath: 'output/imagegen/fictional-adult-avatar-20261012.jpg',
  contentType: 'image/jpeg', width: 768, height: 1024,
  rawByteLength: 133268, rawSha256: '56eb47602d36864b6eec9514ddb091cfa2b71309558c3e12917b3970329b947f',
  normalizedByteLength: 206503, normalizedSha256: 'f71c5d5a76157abfc260125935667e93370235f8caf296842202bdbf825cf018',
});
const guard = '以输入照片为唯一人物参考，严格保留同一个人的身份、五官、脸型、肤色、真实年龄、发型、神态和主要构图；只执行指定效果。不要换脸，不增加人物，不改变性别，不添加文字、标志或边框。';
const instructions = Object.freeze({
  'classic-black-white': '转换为高级经典黑白肖像，保留自然皮肤纹理，黑白层次清楚',
  'new-chinese': '转换为高级新中式人物肖像，现代东方服装、木质空间和柔和侧光',
  'modern-comic': '转换为现代精致漫画肖像，线条明快、色彩自然，保留人物身份与年龄',
  'gentle-watercolor': '转换为温润水彩人物画，纸张肌理、柔和笔触和适度留白',
});
const fail = code => { throw new Error(code); };
const profiles = Object.freeze(Object.fromEntries(originalEffectIds.map(effectId => {
  const spec = Object.freeze({ provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03',
    effectParameters: Object.freeze({ prompt: `${guard}${instructions[effectId]}。输出一张高清完整照片。`,
      negativePrompt: '', size: '1024*1024', n: 1, watermark: true, promptExtend: false }) });
  return [effectId, Object.freeze({ effectId, effectVersion: `${effectId}-v1-20261015`,
    purpose: `photo-effect:${effectId}`, probeVersion: originalEffectsProbeVersion, spec,
    specSha256: createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
    qualityAccepted: false, productionApproved: false })];
})));

// This immutable batch is local acceptance material. It is not runtime policy,
// commercial approval, or an alias to any later edited effect/model version.
export function getOriginalEffectProfile(effectId) {
  if (!originalEffectIds.includes(effectId)) fail('ORIGINAL_EFFECT_ID_INVALID');
  const profile = profiles[effectId], original = getPhotoEffect(effectId);
  if (QWEN_PHOTO_PROVIDER !== profile.spec.provider || QWEN_PHOTO_MODEL !== profile.spec.model
    || original?.id !== effectId || original.type !== 'generative'
    || original.prompt !== profile.spec.effectParameters.prompt) fail('ORIGINAL_EFFECT_SOURCE_DRIFT');
  return profile;
}

export function originalEffectBinding(effectId) {
  const profile = getOriginalEffectProfile(effectId);
  return { ...originalEffectsInput, effectId, effectVersion: profile.effectVersion,
    probeVersion: profile.probeVersion, specSha256: profile.specSha256 };
}
