// Generated from src/data; run scripts/sync-native-product-assets.mjs.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SAMPLE_AVATARS = exports.CREATION_GROUPS = exports.CREATION_TYPES = exports.FEATURED_TEMPLATES = exports.VIDEO_TEMPLATES = exports.TEMPLATES = void 0;
exports.sortVideoTemplatesNewestFirst = sortVideoTemplatesNewestFirst;
exports.loadWorks = loadWorks;
exports.saveWork = saveWork;
exports.removeWork = removeWork;
const DEFAULT_ANCHOR = { fx: 0.5, fy: 0.36, fr: 0.16 };
exports.TEMPLATES = [
    { id: "jinqu", name: "经典歌曲", category: "照片唱歌", group: "singing", mode: "video-fusion", media: "video", description: "让照片唱出经典旋律，成片约 6 秒", cover: "/templates/classic-song-openai-r2.webp", previewVideo: "/templates/classic-song-preview-r9.mp4", duration: "约 1–3 分钟", hot: true, audience: "female", publishedAt: "2026-07-28T10:00:00+08:00", anchor: DEFAULT_ANCHOR },
    { id: "street", name: "夜景唱歌", category: "照片唱歌", group: "singing", mode: "video-fusion", media: "video", description: "夜景街拍唱歌，成片约 25 秒", cover: "/templates/night-song-openai-r2.webp", previewVideo: "/templates/night-song-preview-r9.mp4", duration: "约 2–4 分钟", audience: "female", publishedAt: "2026-08-19T10:00:00+08:00", anchor: DEFAULT_ANCHOR },
    { id: "dance", name: "轻松跳舞", category: "照片跳舞", group: "dancing", mode: "video-fusion", media: "video", description: "舒缓好学的自然舞步，照片一键动起来", cover: "/templates/dance-r12.webp", previewVideo: "/templates/dance-preview-r12.mp4", duration: "约 1–3 分钟", hot: true, audience: "female", publishedAt: "2026-08-24T11:00:00+08:00", anchor: DEFAULT_ANCHOR },
    { id: "quote", name: "暖心语录", category: "情感语录", group: "quote", mode: "video-fusion", media: "video", description: "让照片自然开口，说一句暖心生活感悟", cover: "/templates/quote-r12.webp", previewVideo: "/templates/quote-preview-r12.mp4", duration: "约 1–3 分钟", audience: "male", publishedAt: "2026-08-24T10:00:00+08:00", anchor: DEFAULT_ANCHOR },
    { id: "ai-avatar", name: "AI头像", category: "AI头像", group: "avatar", mode: "photo-anime", media: "image", description: "生成自然耐看的个人头像", cover: "/templates/ai-avatar-openai-r8.webp", duration: "约 30 秒", animeStyle: "portrait", anchor: DEFAULT_ANCHOR },
    { id: "comic", name: "漫画风格", category: "漫画风格", group: "comic", mode: "photo-anime", media: "image", description: "把照片变成鲜明的漫画形象", cover: "/templates/comic-openai-r8.webp", duration: "约 30 秒", animeStyle: "comic", anchor: DEFAULT_ANCHOR },
    { id: "watercolor", name: "水彩画像", category: "写真", group: "portrait", mode: "photo-anime", media: "image", description: "把照片变成温润的手绘画像", cover: "/templates/watercolor-openai-r2.webp", duration: "约 30 秒", animeStyle: "watercolor", anchor: DEFAULT_ANCHOR },
    { id: "westlake", name: "西湖留影", category: "写真", group: "portrait", mode: "photo-bg", media: "image", description: "足不出户拍一张西湖旅行照", cover: "/templates/westlake-openai-r2.webp", duration: "约 30 秒", bgId: "westlake", anchor: DEFAULT_ANCHOR },
    { id: "restore", name: "老照片修复", category: "照片修复", group: "restore", mode: "photo-restore", media: "image", description: "修复模糊破损，并自然上色", cover: "/templates/restore-openai-r2.webp", duration: "约 20 秒", hot: true, anchor: DEFAULT_ANCHOR },
    { id: "younger", name: "重返年轻", category: "照片修复", group: "restore", mode: "photo-age", media: "image", description: "看看三十岁时的自然模样", cover: "/templates/younger-openai-r2.webp", duration: "约 20 秒", targetAge: 30, anchor: DEFAULT_ANCHOR },
];
function sortVideoTemplatesNewestFirst(templates) {
    return [...templates].sort((left, right) => {
        const leftPublished = Date.parse(left.publishedAt || "1970-01-01");
        const rightPublished = Date.parse(right.publishedAt || "1970-01-01");
        return rightPublished - leftPublished || Number(left.sortOrder || 0) - Number(right.sortOrder || 0);
    });
}
const FEATURED_TEMPLATE_IDS = new Set(["jinqu", "dance", "quote", "street"]);
exports.VIDEO_TEMPLATES = sortVideoTemplatesNewestFirst(exports.TEMPLATES.filter((template) => template.enabled !== false && template.media === "video" && Boolean(template.previewVideo)));
exports.FEATURED_TEMPLATES = exports.VIDEO_TEMPLATES.filter((template) => template.featured === true || FEATURED_TEMPLATE_IDS.has(template.id));
exports.CREATION_TYPES = [
    { id: "video", name: "视频玩法", description: "让照片动起来" },
    { id: "image", name: "照片玩法", description: "头像、漫画、写真和修复" },
];
exports.CREATION_GROUPS = [
    { id: "featured", media: "video", name: "精选", shortName: "精选", description: "精选视频模板，挑一个开始制作" },
    { id: "singing", media: "video", name: "唱歌", shortName: "唱歌", description: "让照片唱出一段视频" },
    { id: "dancing", media: "video", name: "跳舞", shortName: "跳舞", description: "正在准备更多跳舞玩法" },
    { id: "quote", media: "video", name: "语录", shortName: "语录", description: "正在准备更多语录玩法" },
    { id: "avatar", media: "image", name: "AI头像", shortName: "AI头像", description: "生成自然耐看的个人头像" },
    { id: "comic", media: "image", name: "漫画风格", shortName: "漫画", description: "把照片变成鲜明的漫画形象" },
    { id: "portrait", media: "image", name: "写真", shortName: "写真", description: "水彩画像和西湖旅行照" },
    { id: "restore", media: "image", name: "修复", shortName: "修复", description: "修复、上色或重返年轻" },
];
exports.SAMPLE_AVATARS = [
    "/avatars/sample-woman-openai-r2.webp",
    "/avatars/sample-man-openai-r2.webp",
    "/avatars/sample-young-woman-openai-r2.webp",
];
function loadWorks() {
    try {
        return JSON.parse(localStorage.getItem("ly_works") || "[]");
    }
    catch (_a) {
        return [];
    }
}
function saveWork(work) {
    const works = loadWorks();
    works.unshift(work);
    try {
        localStorage.setItem("ly_works", JSON.stringify(works.slice(0, 20)));
    }
    catch (_a) {
        localStorage.setItem("ly_works", JSON.stringify(works.slice(0, 5)));
    }
}
function removeWork(id) {
    localStorage.setItem("ly_works", JSON.stringify(loadWorks().filter((work) => work.id !== id)));
}
