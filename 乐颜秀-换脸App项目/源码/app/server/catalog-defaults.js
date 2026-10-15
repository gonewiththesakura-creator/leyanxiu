export const DEFAULT_CATALOG = {
  schemaVersion: 1,
  settings: {
    productName: "乐颜秀",
    generationEnabled: true,
    captionEnabled: true,
    maintenanceNotice: "",
  },
  theme: {
    accent: "#f23bd1",
    secondary: "#72f5d1",
    background: "#000000",
    surface: "#19191d",
    text: "#ffffff",
  },
  templates: [
    { id: "jinqu", name: "经典歌曲", category: "照片唱歌", group: "singing", mode: "video-fusion", media: "video", description: "让照片唱出经典旋律，成片约 6 秒", cover: "/templates/classic-song-openai-r2.webp", previewVideo: "/templates/classic-song-preview-r9.mp4", duration: "约 1-3 分钟", hot: true, featured: true, enabled: true, audience: "female", publishedAt: "2026-07-28T10:00:00+08:00", sortOrder: 40, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "street", name: "夜景唱歌", category: "照片唱歌", group: "singing", mode: "video-fusion", media: "video", description: "夜景街拍唱歌，成片约 25 秒", cover: "/templates/night-song-openai-r2.webp", previewVideo: "/templates/night-song-preview-r9.mp4", duration: "约 2-4 分钟", featured: true, enabled: true, audience: "female", publishedAt: "2026-08-19T10:00:00+08:00", sortOrder: 30, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "dance", name: "轻松跳舞", category: "照片跳舞", group: "dancing", mode: "video-fusion", media: "video", description: "舒缓好学的自然舞步，照片一键动起来", cover: "/templates/dance-r12.webp", previewVideo: "/templates/dance-preview-r12.mp4", duration: "约 1-3 分钟", hot: true, featured: true, enabled: true, audience: "female", publishedAt: "2026-08-24T11:00:00+08:00", sortOrder: 10, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "quote", name: "暖心语录", category: "情感语录", group: "quote", mode: "video-fusion", media: "video", description: "让照片自然开口，说一句暖心生活感悟", cover: "/templates/quote-r12.webp", previewVideo: "/templates/quote-preview-r12.mp4", duration: "约 1-3 分钟", featured: true, enabled: true, audience: "male", publishedAt: "2026-08-24T10:00:00+08:00", sortOrder: 20, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "ai-avatar", name: "AI头像", category: "AI头像", group: "avatar", mode: "photo-anime", media: "image", description: "生成自然耐看的个人头像", cover: "/templates/ai-avatar-openai-r8.webp", duration: "约 30 秒", enabled: true, sortOrder: 10, animeStyle: "portrait", anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "comic", name: "漫画风格", category: "漫画风格", group: "comic", mode: "photo-anime", media: "image", description: "把照片变成鲜明的漫画形象", cover: "/templates/comic-openai-r8.webp", duration: "约 30 秒", enabled: true, sortOrder: 20, animeStyle: "comic", anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "watercolor", name: "水彩画像", category: "写真", group: "portrait", mode: "photo-anime", media: "image", description: "把照片变成温润的手绘画像", cover: "/templates/watercolor-openai-r2.webp", duration: "约 30 秒", enabled: true, sortOrder: 30, animeStyle: "watercolor", anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "westlake", name: "西湖留影", category: "写真", group: "portrait", mode: "photo-bg", media: "image", description: "足不出户拍一张西湖旅行照", cover: "/templates/westlake-openai-r2.webp", duration: "约 30 秒", enabled: true, sortOrder: 40, bgId: "westlake", anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "restore", name: "老照片修复", category: "照片修复", group: "restore", mode: "photo-restore", media: "image", description: "修复模糊破损，并自然上色", cover: "/templates/restore-openai-r2.webp", duration: "约 20 秒", hot: true, enabled: true, sortOrder: 50, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
    { id: "younger", name: "重返年轻", category: "照片修复", group: "restore", mode: "photo-age", media: "image", description: "看看三十岁时的自然模样", cover: "/templates/younger-openai-r2.webp", duration: "约 20 秒", targetAge: 30, enabled: true, sortOrder: 60, anchor: { fx: 0.5, fy: 0.36, fr: 0.16 } },
  ],
  photoCategories: [
    { id: "time", name: "时光穿越", kicker: "岁月影像", description: "年龄、年代与未来感，一张照片看见不同时光", cover: "/effects/time-travel.webp", accent: "#b44352", enabled: true, sortOrder: 10 },
    { id: "culture", name: "国风大片", kicker: "东方美学", description: "宋韵、敦煌、旗袍与水墨江南", cover: "/effects/chinese-style.webp", accent: "#26766b", enabled: true, sortOrder: 20 },
    { id: "art", name: "艺术风格", kicker: "百变画风", description: "漫画、水彩、油画与高级杂志肖像", cover: "/effects/art-styles.webp", accent: "#315fa8", enabled: true, sortOrder: 30 },
    { id: "restore", name: "修复焕新", kicker: "旧照新生", description: "修清、上色、提亮，留住熟悉的面孔", cover: "/effects/restore-renew.webp", accent: "#80643f", enabled: true, sortOrder: 40 },
  ],
  photoEffects: [
    { id: "age-change", title: "年龄变化", subtitle: "一张照片，看见不同人生阶段", categoryId: "time", badge: "热门", targetAge: 60, preview: "/effects/previews/age-change.webp", enabled: true, sortOrder: 10 },
    { id: "hong-kong-90s", title: "九十年代港风", subtitle: "胶片光影里的电影感", categoryId: "time", badge: "新", preview: "/effects/previews/hong-kong-90s.webp", enabled: true, sortOrder: 20 },
    { id: "vintage-80s", title: "八十年代留影", subtitle: "复古色彩与旧时照相馆", categoryId: "time", preview: "/effects/previews/vintage-80s.webp", enabled: true, sortOrder: 30 },
    { id: "classic-black-white", title: "经典黑白照", subtitle: "简洁光影，留下熟悉神态", categoryId: "time", preview: "/effects/previews/classic-black-white.webp", enabled: true, sortOrder: 40 },
    { id: "song-portrait", title: "宋韵雅集", subtitle: "清雅服饰与山水庭院", categoryId: "culture", badge: "热门", preview: "/effects/previews/song-portrait.webp", enabled: true, sortOrder: 10 },
    { id: "dunhuang", title: "敦煌飞天", subtitle: "壁画色彩与轻盈飘带", categoryId: "culture", badge: "新", preview: "/effects/previews/dunhuang.webp", enabled: true, sortOrder: 20 },
    { id: "new-chinese", title: "新中式肖像", subtitle: "现代剪裁与东方气质", categoryId: "culture", preview: "/effects/previews/new-chinese.webp", enabled: true, sortOrder: 30 },
    { id: "cheongsam", title: "海派旗袍", subtitle: "温润端庄的复古写真", categoryId: "culture", preview: "/effects/previews/cheongsam.webp", enabled: true, sortOrder: 40 },
    { id: "natural-avatar", title: "自然AI头像", subtitle: "干净耐看，保留真实年龄", categoryId: "art", badge: "热门", preview: "/effects/previews/natural-avatar.webp", enabled: true, sortOrder: 10 },
    { id: "modern-comic", title: "现代漫画像", subtitle: "线条明快，还是熟悉的自己", categoryId: "art", preview: "/effects/previews/modern-comic.webp", enabled: true, sortOrder: 20 },
    { id: "gentle-watercolor", title: "温润水彩像", subtitle: "柔和笔触，像一张手绘留影", categoryId: "art", preview: "/effects/previews/gentle-watercolor.webp", enabled: true, sortOrder: 30 },
    { id: "classic-oil", title: "经典油画肖像", subtitle: "细腻质感与沉稳色彩", categoryId: "art", preview: "/effects/previews/classic-oil.webp", enabled: true, sortOrder: 40 },
    { id: "pencil-sketch", title: "铅笔素描像", subtitle: "清楚轮廓，也留下神态", categoryId: "art", preview: "/effects/previews/pencil-sketch.webp", enabled: true, sortOrder: 50 },
    { id: "face-enhance", title: "老照片清晰修复", subtitle: "修清人脸细节，保留原来的样子", categoryId: "restore", badge: "热门", preview: "/effects/previews/face-enhance.webp", enabled: true, sortOrder: 10 },
    { id: "natural-color", title: "黑白照片上色", subtitle: "补上自然颜色，旧影更有温度", categoryId: "restore", preview: "/effects/previews/natural-color.webp", enabled: true, sortOrder: 20 },
    { id: "super-resolution", title: "高清放大", subtitle: "提升清晰度，适合保存与冲印", categoryId: "restore", preview: "/effects/previews/super-resolution.webp", enabled: true, sortOrder: 30 },
    { id: "scratch-repair", title: "破损旧照修复", subtitle: "去划痕与折痕，保持人物原貌", categoryId: "restore", badge: "AI修复", preview: "/effects/previews/scratch-repair.webp", enabled: true, sortOrder: 40 },
  ],
};

export function cloneDefaultCatalog() {
  return JSON.parse(JSON.stringify(DEFAULT_CATALOG));
}
