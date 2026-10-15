const ageEffects = {
  "age-change": { id: "age-change", type: "age", age: 60 },
};

const promptEffects = {
  "hong-kong-90s": "转换为九十年代香港电影人像，使用自然胶片颗粒、克制霓虹侧光和复古发型服装",
  "vintage-80s": "转换为八十年代中国照相馆纪念照，使用当年常见服装、布景和温润胶片色彩",
  "classic-black-white": "转换为高级经典黑白肖像，保留自然皮肤纹理，黑白层次清楚",
  "song-portrait": "转换为宋代雅集人物肖像，清雅宋制服饰，山水庭院，真实摄影质感",
  dunhuang: "转换为敦煌飞天艺术肖像，壁画配色、轻盈飘带与洞窟光影，人物真实自然",
  "new-chinese": "转换为高级新中式人物肖像，现代东方服装、木质空间和柔和侧光",
  cheongsam: "转换为海派旗袍复古写真，端庄得体，老上海室内光影，真实摄影",
  "natural-avatar": "制作自然高级的个人头像，干净中性背景、专业柔光和头肩构图，保留真实年龄",
  "modern-comic": "转换为现代精致漫画肖像，线条明快、色彩自然，保留人物身份与年龄",
  "gentle-watercolor": "转换为温润水彩人物画，纸张肌理、柔和笔触和适度留白",
  "classic-oil": "转换为经典写实油画肖像，细腻笔触、沉稳色彩和博物馆级布光",
  "pencil-sketch": "转换为专业铅笔素描肖像，轮廓准确、明暗细腻、保留人物神态",
  "scratch-repair": "修复旧照片，去除划痕、折痕、污渍和偏色，降低噪点并恢复真实细节，不改变人物、服装、姿势和背景",
};

const fixedEffects = {
  "face-enhance": { id: "face-enhance", type: "enhance" },
  "natural-color": { id: "natural-color", type: "colorize" },
  "super-resolution": { id: "super-resolution", type: "wanx", functionName: "super_resolution", prompt: "图像高清放大，保持原始内容不变" },
};

const identityGuard = "以输入照片为唯一人物参考，严格保留同一个人的身份、五官、脸型、肤色、真实年龄、发型、神态和主要构图；只执行指定效果。不要换脸，不增加人物，不改变性别，不添加文字、标志或边框。";

const promptEntries = Object.fromEntries(Object.entries(promptEffects).map(([id, instruction]) => [
  id,
  { id, type: "generative", prompt: `${identityGuard}${instruction}。输出一张高清完整照片。` },
]));

export const PHOTO_EFFECTS = { ...ageEffects, ...promptEntries, ...fixedEffects };

export function getPhotoEffect(id) {
  return PHOTO_EFFECTS[id] || null;
}

export function customPhotoEffect(id, instruction) {
  return { id, type: "generative", prompt: `${identityGuard}${instruction}。输出一张高清完整照片。` };
}

export function listPhotoEffects() {
  return Object.values(PHOTO_EFFECTS).map(({ id, type }) => ({ id, type }));
}
