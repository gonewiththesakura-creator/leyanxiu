import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloneDefaultCatalog, DEFAULT_CATALOG } from "./catalog-defaults.js";
import { getPhotoEffect, customPhotoEffect } from "./photo-effects.js";
import { ADMIN_ASSET_ROOT } from "./admin-media-paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ADMIN_DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = process.env.ADMIN_STORE_FILE || path.join(DATA_DIR, "admin-console.json");
const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
const MAX_RELEASES = 30;
const PUBLIC_ROOTS = [ADMIN_ASSET_ROOT, path.join(__dirname, "web"), path.resolve(__dirname, "..", "public")];
const PUBLIC_ASSET_PREFIXES = ["/templates/", "/effects/", "/banners/", "/plays/", "/avatars/"];
const assetDigestCache = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function initialState() {
  const catalog = cloneDefaultCatalog();
  const createdAt = now();
  const catalogHash = catalogDigest(catalog);
  const assetManifest = catalogAssetManifest(catalog);
  const release = {
    id: id("rel"),
    version: 1,
    action: "seed",
    note: "代码内置初始配置",
    publishedAt: createdAt,
    publishedBy: "system",
    catalog: clone(catalog),
    catalogHash,
    assetManifest,
    integrityStatus: "sealed",
    integritySealedAt: createdAt,
  };
  return {
    schemaVersion: 1,
    draft: { revision: 1, updatedAt: createdAt, updatedBy: "system", note: "", catalog: clone(catalog), catalogHash, assetManifest, integrityStatus: "sealed", integritySealedAt: createdAt },
    published: { releaseId: release.id, version: release.version, publishedAt: createdAt, publishedBy: "system", catalog: clone(catalog), catalogHash, assetManifest, integrityStatus: "sealed", integritySealedAt: createdAt },
    releases: [release],
    audits: [{ id: id("adm"), action: "catalog.seeded", actor: "system", createdAt, details: { version: 1 } }],
  };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, STORE_FILE);
}

function loadState() {
  if (!fs.existsSync(STORE_FILE)) {
    const state = initialState();
    writeState(state);
    return state;
  }
  const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  if (!parsed || parsed.schemaVersion !== 1 || !parsed.draft?.catalog || !parsed.published?.catalog) {
    throw new Error(`不支持的后台配置版本: ${STORE_FILE}`);
  }
  const migration = migrateStateIntegrity(parsed);
  if (migration.changed) {
    migration.state.audits ||= [];
    migration.state.audits.push({
      id: id("adm"),
      action: "catalog.integrity_migrated",
      actor: "system",
      createdAt: migration.migratedAt,
      details: migration.details,
    });
    writeState(migration.state);
  }
  return migration.state;
}

let state = loadState();

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, label, min, max) {
  const normalized = String(value ?? "").trim();
  if (normalized.length < min || normalized.length > max) fail("INVALID_CATALOG", `${label}需为 ${min}-${max} 个字符`);
  return normalized;
}

function boolean(value) {
  return value === true;
}

function order(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 9999) fail("INVALID_CATALOG", "排序值需为 0-9999 的整数");
  return parsed;
}

function hex(value, label) {
  const normalized = String(value || "").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) fail("INVALID_CATALOG", `${label}需使用六位十六进制颜色`);
  return normalized;
}

function luminance(value) {
  const channels = value.slice(1).match(/.{2}/g).map((part) => Number.parseInt(part, 16) / 255);
  const adjusted = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return adjusted[0] * 0.2126 + adjusted[1] * 0.7152 + adjusted[2] * 0.0722;
}

function contrast(left, right) {
  const high = Math.max(luminance(left), luminance(right));
  const low = Math.min(luminance(left), luminance(right));
  return (high + 0.05) / (low + 0.05);
}

function assetPath(value, label, extensions) {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//") || /[\\%?#\r\n]/.test(normalized)) {
    fail("INVALID_CATALOG", `${label}只允许同域绝对路径`);
  }
  const pathname = normalized.toLowerCase();
  if (pathname.includes("..") || !PUBLIC_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    fail("INVALID_CATALOG", `${label}不属于受控素材目录`);
  }
  if (!extensions.some((extension) => pathname.endsWith(extension))) fail("INVALID_CATALOG", `${label}文件格式不受支持`);
  const relative = pathname.replace(/^\/+/, "");
  if (!PUBLIC_ROOTS.some((root) => fs.existsSync(path.join(root, relative)))) {
    fail("INVALID_CATALOG", `${label}对应的素材不存在，请先完成素材入库`);
  }
  return normalized;
}

function catalogDigest(catalog) {
  return crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

function catalogAssetPaths(catalog) {
  return [...new Set([
    ...catalog.templates.flatMap((item) => [item.cover, item.previewVideo].filter(Boolean)),
    ...catalog.photoCategories.map((item) => item.cover),
    ...catalog.photoEffects.map((item) => item.preview).filter(Boolean),
  ].map((value) => String(value).split(/[?#]/, 1)[0].toLowerCase()))].sort();
}

function catalogAssetManifest(catalog) {
  return Object.fromEntries(catalogAssetPaths(catalog).map((asset) => {
    const file = resolveAssetFile(asset);
    if (!file) fail("INVALID_CATALOG", `素材不存在：${asset}`);
    return [asset, digestAssetFile(file)];
  }));
}

function resolveAssetFile(asset) {
  const relative = String(asset || "").replace(/^\/+/, "");
  return PUBLIC_ROOTS.map((root) => path.join(root, relative)).find((candidate) => fs.existsSync(candidate));
}

function digestAssetFile(file) {
  const stat = fs.statSync(file);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = assetDigestCache.get(file);
  if (cached?.signature === signature) return cached.digest;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assetDigestCache.set(file, { signature, digest });
  return digest;
}

function sealCurrentEntry(entry, label, migratedAt) {
  const storedDigest = catalogDigest(entry.catalog);
  if (entry.catalogHash && entry.catalogHash !== storedDigest) {
    throw new Error(`${label}配置摘要校验失败，疑似发生未审计修改`);
  }
  const normalized = validateCatalog(entry.catalog);
  const digest = catalogDigest(normalized);
  let changed = false;
  if (!sameCatalog(entry.catalog, normalized)) {
    entry.catalog = normalized;
    entry.catalogHash = digest;
    changed = true;
  }
  if (!entry.catalogHash) {
    entry.catalogHash = digest;
    changed = true;
  }
  if (!entry.assetManifest) {
    entry.assetManifest = catalogAssetManifest(normalized);
    changed = true;
  }
  if (entry.integrityStatus !== "sealed") {
    entry.integrityStatus = "sealed";
    changed = true;
  }
  if (!entry.integritySealedAt) {
    entry.integritySealedAt = migratedAt;
    changed = true;
  }
  return changed;
}

function migrateStateIntegrity(input) {
  const migratedAt = now();
  let changed = false;
  const details = { currentDraftSealed: false, currentPublishedSealed: false, currentReleaseSealed: false, legacyReleasesBlocked: 0 };
  if (sealCurrentEntry(input.draft, "当前草稿", migratedAt)) {
    changed = true;
    details.currentDraftSealed = true;
  }
  if (sealCurrentEntry(input.published, "当前发布版本", migratedAt)) {
    changed = true;
    details.currentPublishedSealed = true;
  }
  input.releases ||= [];
  for (const release of input.releases) {
    if (release.id === input.published.releaseId && (!release.catalogHash || !release.assetManifest)) {
      release.catalogHash = input.published.catalogHash;
      release.assetManifest = clone(input.published.assetManifest);
      release.integrityStatus = "sealed";
      release.integritySealedAt = migratedAt;
      changed = true;
      details.currentReleaseSealed = true;
      continue;
    }
    if (release.catalogHash && release.assetManifest) {
      if (release.integrityStatus !== "sealed") {
        release.integrityStatus = "sealed";
        changed = true;
      }
      if (!release.integritySealedAt) {
        release.integritySealedAt = release.publishedAt || migratedAt;
        changed = true;
      }
      if (release.integrityReason) {
        delete release.integrityReason;
        changed = true;
      }
      continue;
    }
    if (release.integrityStatus !== "legacy-unsealed") {
      release.integrityStatus = "legacy-unsealed";
      release.integrityReason = "历史版本缺少发布时素材指纹，必须重新审核后才能恢复";
      changed = true;
    }
    details.legacyReleasesBlocked += 1;
  }
  return { state: input, changed, migratedAt, details };
}

function sameManifest(left, right) {
  return Boolean(left && right) && JSON.stringify(left) === JSON.stringify(right);
}

function normalizeCollection(input, defaults, mapper, label, extraMapper) {
  if (!Array.isArray(input) || input.length < defaults.length || input.length > defaults.length + 200) fail("INVALID_CATALOG", `${label}数量超出支持范围`);
  const byId = new Map(input.map((item) => [String(item?.id || ""), item]));
  if (byId.size !== input.length || defaults.some((item) => !byId.has(item.id))) fail("INVALID_CATALOG", `${label}内置标识不可删除，标识不可重复`);
  const defaultIds = new Set(defaults.map((item) => item.id));
  const extras = input.filter((item) => !defaultIds.has(item.id));
  if (extras.length && !extraMapper) fail("INVALID_CATALOG", `${label}不支持新增`);
  return [...defaults.map((base) => mapper(byId.get(base.id), base)), ...extras.map((item) => mapper(item, extraMapper(item)))];
}

function customId(item, prefix) {
  if (!new RegExp(`^custom-${prefix}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(String(item.id))) {
    fail("INVALID_CATALOG", "新增内容标识无效，请通过新增按钮创建");
  }
  return item.id;
}

function videoBase(item) {
  const id = customId(item, "video");
  if (item.media !== "video" || item.mode !== "video-fusion" || !["singing", "dancing", "quote"].includes(item.group)) fail("INVALID_CATALOG", "新视频必须选择唱歌、跳舞或语录");
  if (!/^\/effects\/uploads\/[a-z0-9-]+\.mp4$/.test(String(item.previewVideo))) fail("INVALID_CATALOG", "新视频模板必须使用素材库上传的 MP4 作为预览和制作源");
  return { id, media: "video", mode: "video-fusion", group: item.group, previewVideo: item.previewVideo, audience: "all", anchor: { fx: 0.5, fy: 0.36, fr: 0.16 }, rightsReference: text(item.rightsReference, "视频授权依据", 4, 200) };
}

function categoryBase(item) {
  return { id: customId(item, "category") };
}

function effectBase(item) {
  return { id: customId(item, "effect"), categoryId: item.categoryId, prompt: text(item.prompt, "效果提示词", 10, 1500) };
}

export function validateCatalog(input) {
  if (!input || typeof input !== "object") fail("INVALID_CATALOG", "配置内容无效");
  const theme = {
    accent: hex(input.theme?.accent, "主色"),
    secondary: hex(input.theme?.secondary, "辅助色"),
    background: hex(input.theme?.background, "背景色"),
    surface: hex(input.theme?.surface, "卡片色"),
    text: hex(input.theme?.text, "文字色"),
  };
  if (contrast(theme.text, theme.background) < 4.5 || contrast(theme.text, theme.surface) < 4.5) {
    fail("LOW_CONTRAST", "文字与背景对比度不足 4.5:1，无法发布");
  }

  const templates = normalizeCollection(input.templates, DEFAULT_CATALOG.templates, (item, base) => {
    const managed = base.media === "video" && String(item.previewVideo || "").startsWith("/effects/uploads/");
    if (base.media === "video" && item.previewVideo !== base.previewVideo && !managed) fail("INVALID_CATALOG", "更换视频必须从素材库选择 MP4，同步作为预览和制作源");
    if (managed && !/^\/effects\/uploads\/[a-z0-9-]+\.mp4$/.test(item.previewVideo)) fail("INVALID_CATALOG", "制作源必须为素材库 MP4");
    return {
    ...clone(base),
    ...(managed ? { rightsReference: text(item.rightsReference, "视频授权依据", 4, 200) } : {}),
    name: text(item.name, `${base.id} 名称`, 2, 24),
    category: text(item.category, `${base.id} 分类`, 2, 16),
    description: text(item.description, `${base.id} 描述`, 4, 80),
    cover: assetPath(item.cover, `${base.id} 封面`, [".jpg", ".jpeg", ".png", ".webp"]),
    ...(base.previewVideo ? { previewVideo: assetPath(item.previewVideo, `${base.id} 动态预览`, [".mp4", ".webm"]) } : {}),
    duration: text(item.duration, `${base.id} 时长`, 2, 20),
    enabled: boolean(item.enabled),
    hot: boolean(item.hot),
    featured: base.media === "video" && boolean(item.featured),
    audience: ["male", "female", "all"].includes(item.audience) ? item.audience : base.audience,
    publishedAt: base.media === "video" && Number.isFinite(Date.parse(item.publishedAt)) ? new Date(item.publishedAt).toISOString() : base.publishedAt,
    sortOrder: order(item.sortOrder),
  }; }, "模板", videoBase);

  const photoCategories = normalizeCollection(input.photoCategories, DEFAULT_CATALOG.photoCategories, (item, base) => ({
    ...clone(base),
    name: text(item.name, `${base.id} 分类名称`, 2, 12),
    kicker: text(item.kicker, `${base.id} 分类标签`, 2, 12),
    description: text(item.description, `${base.id} 分类描述`, 4, 60),
    cover: assetPath(item.cover, `${base.id} 分类封面`, [".jpg", ".jpeg", ".png", ".webp"]),
    accent: hex(item.accent, `${base.id} 分类色`),
    enabled: boolean(item.enabled),
    sortOrder: order(item.sortOrder),
  }), "图片分类", categoryBase);

  const categoryIds = new Set(photoCategories.map((item) => item.id));
  const photoEffects = normalizeCollection(input.photoEffects, DEFAULT_CATALOG.photoEffects, (item, base) => {
    if (!categoryIds.has(item.categoryId)) fail("INVALID_CATALOG", `${base.id} 所属分类不存在`);
    const prompt = String(item.prompt || "").trim();
    const supportsPrompt = base.id.startsWith("custom-effect-") || getPhotoEffect(base.id)?.type === "generative";
    if (prompt && !supportsPrompt) fail("INVALID_CATALOG", "该固定算法不接受提示词");
    if (base.id.startsWith("custom-effect-") && !prompt) fail("INVALID_CATALOG", "新效果必须填写提示词");
    return {
      ...clone(base),
      categoryId: item.categoryId,
      ...(prompt ? { prompt: text(prompt, "效果提示词", 10, 1500) } : {}),
      title: text(item.title, `${base.id} 名称`, 2, 24),
      subtitle: text(item.subtitle, `${base.id} 描述`, 4, 60),
      badge: String(item.badge || "").trim().slice(0, 8) || undefined,
      preview: assetPath(item.preview, `${base.id} 效果图`, [".jpg", ".jpeg", ".png", ".webp"]),
      enabled: boolean(item.enabled),
      sortOrder: order(item.sortOrder),
    };
  }, "图片效果", effectBase);

  return {
    schemaVersion: 1,
    settings: {
      productName: text(input.settings?.productName, "产品名称", 2, 12),
      generationEnabled: boolean(input.settings?.generationEnabled),
      captionEnabled: boolean(input.settings?.captionEnabled),
      maintenanceNotice: String(input.settings?.maintenanceNotice || "").trim().slice(0, 80),
    },
    theme,
    templates,
    photoCategories,
    photoEffects,
  };
}

function sameCatalog(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function catalogDiffSummary(left, right) {
  const changed = (before, after) => {
    const byId = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
    return after.filter((item) => byId.get(item.id) !== JSON.stringify(item)).length;
  };
  return {
    settings: sameCatalog(left.settings, right.settings) ? 0 : 1,
    theme: Object.keys(right.theme).filter((key) => left.theme[key] !== right.theme[key]).length,
    templates: changed(left.templates, right.templates),
    photoCategories: changed(left.photoCategories, right.photoCategories),
    photoEffects: changed(left.photoEffects, right.photoEffects),
  };
}

function audit(action, actor, details = {}) {
  state.audits.push({ id: id("adm"), action, actor, createdAt: now(), details: clone(details) });
  if (state.audits.length > 3000) state.audits.splice(0, state.audits.length - 3000);
}

export const adminStore = {
  file: STORE_FILE,

  executionPhotoEffect(effectId) {
    const catalog = state.published.catalog;
    const effect = catalog.photoEffects.find((item) => item.id === effectId && item.enabled !== false
      && catalog.photoCategories.some((category) => category.id === item.categoryId && category.enabled !== false));
    if (!effect) return null;
    return effect.prompt ? customPhotoEffect(effect.id, effect.prompt) : getPhotoEffect(effect.id);
  },

  publicCatalog() {
    const catalog = state.published.catalog;
    const categories = catalog.photoCategories.filter((item) => item.enabled !== false);
    const categoryIds = new Set(categories.map((item) => item.id));
    return clone({
      ...catalog,
      templates: catalog.templates.filter((item) => item.enabled !== false),
      photoCategories: categories,
      photoEffects: catalog.photoEffects.filter((item) => item.enabled !== false && categoryIds.has(item.categoryId)),
      release: {
      id: state.published.releaseId,
      version: state.published.version,
      publishedAt: state.published.publishedAt,
      },
    });
  },

  workspace() {
    const { assetManifest: _draftAssets, catalogHash: _draftHash, ...draft } = state.draft;
    return clone({
      draft,
      published: {
        releaseId: state.published.releaseId,
        version: state.published.version,
        publishedAt: state.published.publishedAt,
        publishedBy: state.published.publishedBy,
        integrityStatus: state.published.integrityStatus,
        catalog: state.published.catalog,
      },
      dirty: !sameCatalog(state.draft.catalog, state.published.catalog),
      releases: [...state.releases].reverse().map(({ catalog: _catalog, assetManifest: _assets, catalogHash: _hash, ...release }) => release),
    });
  },

  updateDraft({ catalog, expectedRevision, actor, note = "" }) {
    if (Number(expectedRevision) !== state.draft.revision) fail("REVISION_CONFLICT", "草稿已被其他人更新，请刷新后重试", { currentRevision: state.draft.revision });
    const normalized = validateCatalog(catalog);
    const diff = catalogDiffSummary(state.draft.catalog, normalized);
    const catalogHash = catalogDigest(normalized);
    const assetManifest = catalogAssetManifest(normalized);
    state.draft = {
      revision: state.draft.revision + 1,
      updatedAt: now(),
      updatedBy: actor,
      note: String(note || "").trim().slice(0, 120),
      catalog: normalized,
      catalogHash,
      assetManifest,
      integrityStatus: "sealed",
      integritySealedAt: now(),
    };
    audit("catalog.draft_saved", actor, { revision: state.draft.revision, note: state.draft.note, catalogHash, diff });
    writeState(state);
    return this.workspace();
  },

  publish({ expectedRevision, actor, note }) {
    if (Number(expectedRevision) !== state.draft.revision) fail("REVISION_CONFLICT", "草稿版本已变化，请刷新后重试", { currentRevision: state.draft.revision });
    if (sameCatalog(state.draft.catalog, state.published.catalog)) fail("NO_CHANGES", "当前没有待发布变更");
    const publishNote = text(note, "发布说明", 4, 120);
    const normalized = validateCatalog(state.draft.catalog);
    const currentManifest = catalogAssetManifest(normalized);
    if (state.draft.assetManifest && !sameManifest(state.draft.assetManifest, currentManifest)) {
      fail("ASSET_CHANGED", "草稿引用的素材在保存后发生变化，请重新检查并保存草稿");
    }
    const catalogHash = catalogDigest(normalized);
    const draftRevision = state.draft.revision;
    const submittedBy = state.draft.updatedBy;
    const baseReleaseId = state.published.releaseId;
    const baseVersion = state.published.version;
    const diff = catalogDiffSummary(state.published.catalog, normalized);
    const publishedAt = now();
    const release = {
      id: id("rel"),
      version: state.published.version + 1,
      action: "publish",
      note: publishNote,
      publishedAt,
      publishedBy: actor,
      submittedBy,
      draftRevision,
      baseReleaseId,
      catalog: clone(normalized),
      catalogHash,
      assetManifest: currentManifest,
      integrityStatus: "sealed",
      integritySealedAt: publishedAt,
    };
    state.releases.push(release);
    if (state.releases.length > MAX_RELEASES) state.releases.splice(0, state.releases.length - MAX_RELEASES);
    state.published = { releaseId: release.id, version: release.version, publishedAt, publishedBy: actor, catalog: clone(release.catalog), catalogHash, assetManifest: currentManifest, integrityStatus: "sealed", integritySealedAt: publishedAt };
    state.draft = { ...state.draft, revision: state.draft.revision + 1, updatedAt: publishedAt, updatedBy: actor, note: "", catalog: clone(release.catalog), catalogHash, assetManifest: currentManifest, integrityStatus: "sealed", integritySealedAt: publishedAt };
    audit("catalog.published", actor, { releaseId: release.id, version: release.version, note: publishNote, catalogHash, submittedBy, draftRevision, baseReleaseId, baseVersion, diff });
    writeState(state);
    return this.workspace();
  },

  rollback({ releaseId, actor, note }) {
    const target = state.releases.find((release) => release.id === releaseId);
    if (!target) fail("RELEASE_NOT_FOUND", "找不到指定历史版本");
    if (target.id === state.published.releaseId) fail("NO_CHANGES", "该版本已经在线");
    if (!target.catalogHash || !target.assetManifest || target.integrityStatus === "legacy-unsealed") {
      fail("UNSEALED_RELEASE", "该历史版本缺少发布时素材指纹，必须重新审核并封印后才能回滚");
    }
    const rollbackNote = text(note, "回滚说明", 4, 120);
    const normalized = validateCatalog(target.catalog);
    const currentManifest = catalogAssetManifest(normalized);
    if (target.assetManifest && !sameManifest(target.assetManifest, currentManifest)) {
      fail("ASSET_CHANGED", "历史版本引用的素材已经变化，不能直接回滚");
    }
    const catalogHash = catalogDigest(normalized);
    const baseReleaseId = state.published.releaseId;
    const baseVersion = state.published.version;
    const diff = catalogDiffSummary(state.published.catalog, normalized);
    const publishedAt = now();
    const release = {
      id: id("rel"),
      version: state.published.version + 1,
      action: "rollback",
      sourceReleaseId: target.id,
      note: rollbackNote,
      publishedAt,
      publishedBy: actor,
      baseReleaseId,
      catalog: clone(normalized),
      catalogHash,
      assetManifest: currentManifest,
      integrityStatus: "sealed",
      integritySealedAt: publishedAt,
    };
    state.releases.push(release);
    if (state.releases.length > MAX_RELEASES) state.releases.splice(0, state.releases.length - MAX_RELEASES);
    state.published = { releaseId: release.id, version: release.version, publishedAt, publishedBy: actor, catalog: clone(release.catalog), catalogHash, assetManifest: currentManifest, integrityStatus: "sealed", integritySealedAt: publishedAt };
    state.draft = { revision: state.draft.revision + 1, updatedAt: publishedAt, updatedBy: actor, note: "", catalog: clone(release.catalog), catalogHash, assetManifest: currentManifest, integrityStatus: "sealed", integritySealedAt: publishedAt };
    audit("catalog.rolled_back", actor, { releaseId: release.id, sourceReleaseId: target.id, version: release.version, note: rollbackNote, catalogHash, baseReleaseId, baseVersion, diff });
    writeState(state);
    return this.workspace();
  },

  emergencyPause({ actor, reason }) {
    const pauseReason = text(reason, "停机原因", 4, 120);
    const catalog = clone(state.published.catalog);
    if (!catalog.settings.generationEnabled) fail("NO_CHANGES", "生成服务已经暂停");
    catalog.settings.generationEnabled = false;
    catalog.settings.maintenanceNotice = "创作服务维护中，请稍后再试";
    state.draft = { revision: state.draft.revision + 1, updatedAt: now(), updatedBy: actor, note: pauseReason, catalog, catalogHash: catalogDigest(catalog), assetManifest: catalogAssetManifest(catalog) };
    return this.publish({ expectedRevision: state.draft.revision, actor, note: `紧急停机：${pauseReason}` });
  },

  audits(limit = 200) {
    return clone(state.audits.slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).reverse());
  },

  summary() {
    const published = state.published.catalog;
    return {
      version: state.published.version,
      releaseId: state.published.releaseId,
      publishedAt: state.published.publishedAt,
      enabledTemplates: published.templates.filter((item) => item.enabled).length,
      enabledVideoTemplates: published.templates.filter((item) => item.enabled && item.media === "video").length,
      enabledPhotoEffects: published.photoEffects.filter((item) => item.enabled).length,
      generationEnabled: published.settings.generationEnabled,
      dirty: !sameCatalog(state.draft.catalog, state.published.catalog),
      draftRevision: state.draft.revision,
      integrityStatus: state.published.integrityStatus,
    };
  },

  verifyPublishedAsset(assetPathValue) {
    const rawAsset = String(assetPathValue || "");
    let asset;
    try {
      asset = decodeURIComponent(rawAsset).toLowerCase();
    } catch {
      return { managed: true, valid: false, reason: "invalid-path" };
    }
    if (!asset.startsWith("/") || asset.startsWith("//") || /[\\?#\r\n\0]/.test(asset) || asset.includes("..")) {
      return { managed: true, valid: false, reason: "invalid-path" };
    }
    const managedAssets = new Set(catalogAssetPaths(state.published.catalog));
    if (!managedAssets.has(asset)) return { managed: false, valid: true };
    const expected = state.published.assetManifest?.[asset];
    if (!expected) return { managed: true, valid: false, reason: "unsealed" };
    const file = resolveAssetFile(asset);
    if (!file) return { managed: true, valid: false, reason: "missing" };
    const actual = digestAssetFile(file);
    return { managed: true, valid: actual === expected, reason: actual === expected ? undefined : "changed" };
  },
};

export function adminStoreReadiness() {
  const blockers = PRODUCTION ? ["后台配置仓库仍为单机 JSON；生产发布前需迁移到带事务、备份和访问审计的数据库"] : [];
  return { ready: blockers.length === 0, backend: "local-json", productionSupported: false, file: PRODUCTION ? null : STORE_FILE, blockers };
}

export function resetAdminStoreForTests() {
  state = initialState();
  writeState(state);
}

export function migrateAdminStateIntegrityForTests(input) {
  if (process.env.NODE_ENV !== "test") throw new Error("仅测试环境可调用");
  return clone(migrateStateIntegrity(clone(input)).state);
}

export function markReleaseUnsealedForTests(releaseId) {
  if (process.env.NODE_ENV !== "test") throw new Error("仅测试环境可调用");
  const release = state.releases.find((item) => item.id === releaseId);
  if (!release) throw new Error("测试版本不存在");
  delete release.catalogHash;
  delete release.assetManifest;
  release.integrityStatus = "legacy-unsealed";
}

export function corruptPublishedAssetSealForTests(assetPathValue) {
  if (process.env.NODE_ENV !== "test") throw new Error("仅测试环境可调用");
  state.published.assetManifest[String(assetPathValue).toLowerCase()] = "0".repeat(64);
}
