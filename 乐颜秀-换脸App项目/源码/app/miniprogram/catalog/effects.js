// Generated from src/data; run scripts/sync-native-product-assets.mjs.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHOTO_EFFECTS = exports.PHOTO_EFFECT_CATEGORIES = void 0;
exports.photoEffectToTemplate = photoEffectToTemplate;
exports.PHOTO_EFFECT_CATEGORIES = [
    { id: "time", name: "时光穿越", kicker: "岁月影像", description: "年龄、年代与未来感，一张照片看见不同时光", cover: "/effects/time-travel.webp", accent: "#b44352" },
    { id: "culture", name: "国风大片", kicker: "东方美学", description: "宋韵、敦煌、旗袍与水墨江南", cover: "/effects/chinese-style.webp", accent: "#26766b" },
    { id: "art", name: "艺术风格", kicker: "百变画风", description: "漫画、水彩、油画与高级杂志肖像", cover: "/effects/art-styles.webp", accent: "#315fa8" },
    { id: "restore", name: "修复焕新", kicker: "旧照新生", description: "修清、上色、提亮，留住熟悉的面孔", cover: "/effects/restore-renew.webp", accent: "#80643f" },
];
const timeEffects = [
    { id: "age-change", title: "年龄变化", subtitle: "一张照片，看见不同人生阶段", badge: "热门", targetAge: 60 },
    { id: "hong-kong-90s", title: "九十年代港风", subtitle: "胶片光影里的电影感", badge: "新" },
    { id: "vintage-80s", title: "八十年代留影", subtitle: "复古色彩与旧时照相馆" },
    { id: "classic-black-white", title: "经典黑白照", subtitle: "简洁光影，留下熟悉神态" },
];
const cultureEffects = [
    { id: "song-portrait", title: "宋韵雅集", subtitle: "清雅服饰与山水庭院", badge: "热门" },
    { id: "dunhuang", title: "敦煌飞天", subtitle: "壁画色彩与轻盈飘带", badge: "新" },
    { id: "new-chinese", title: "新中式肖像", subtitle: "现代剪裁与东方气质" },
    { id: "cheongsam", title: "海派旗袍", subtitle: "温润端庄的复古写真" },
];
const artEffects = [
    { id: "natural-avatar", title: "自然AI头像", subtitle: "干净耐看，保留真实年龄", badge: "热门" },
    { id: "modern-comic", title: "现代漫画像", subtitle: "线条明快，还是熟悉的自己" },
    { id: "gentle-watercolor", title: "温润水彩像", subtitle: "柔和笔触，像一张手绘留影" },
    { id: "classic-oil", title: "经典油画肖像", subtitle: "细腻质感与沉稳色彩" },
    { id: "pencil-sketch", title: "铅笔素描像", subtitle: "清楚轮廓，也留下神态" },
];
const restoreEffects = [
    { id: "face-enhance", title: "老照片清晰修复", subtitle: "修清人脸细节，保留原来的样子", badge: "热门" },
    { id: "natural-color", title: "黑白照片上色", subtitle: "补上自然颜色，旧影更有温度" },
    { id: "super-resolution", title: "高清放大", subtitle: "提升清晰度，适合保存与冲印" },
    { id: "scratch-repair", title: "破损旧照修复", subtitle: "去划痕与折痕，保持人物原貌", badge: "AI修复" },
];
exports.PHOTO_EFFECTS = [
    ...timeEffects.map((effect) => ({ ...effect, categoryId: "time" })),
    ...cultureEffects.map((effect) => ({ ...effect, categoryId: "culture" })),
    ...artEffects.map((effect) => ({ ...effect, categoryId: "art" })),
    ...restoreEffects.map((effect) => ({ ...effect, categoryId: "restore" })),
].map((effect) => ({ ...effect, preview: `/effects/previews/${effect.id}.webp` }));
function photoEffectToTemplate(effect, categories = exports.PHOTO_EFFECT_CATEGORIES) {
    const category = categories.find((item) => item.id === effect.categoryId) || exports.PHOTO_EFFECT_CATEGORIES.find((item) => item.id === effect.categoryId);
    const isAgeChange = effect.id === "age-change";
    return {
        id: `effect-${effect.id}`,
        name: effect.title,
        category: category.name,
        group: effect.categoryId === "restore" ? "restore" : "portrait",
        mode: isAgeChange ? "photo-age" : "photo-effect",
        media: "image",
        description: effect.subtitle,
        cover: effect.preview || category.cover,
        duration: isAgeChange ? "约 20 秒" : "约 30–60 秒",
        targetAge: effect.targetAge,
        agePicker: isAgeChange,
        effectId: isAgeChange ? undefined : effect.id,
        anchor: { fx: 0.5, fy: 0.36, fr: 0.16 },
    };
}
