import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Check,
  CircleAlert,
  Music2,
  ShieldCheck,
  Smartphone,
  ThumbsUp,
  Trophy,
  UserRound,
  WandSparkles,
  X,
} from "lucide-react";
import { projectCatalogForClient, type RuntimeCatalog } from "@/data/runtimeCatalog";
import type { PhotoEffectCategoryId } from "@/data/effects";
import { sortVideoTemplatesNewestFirst, type Template } from "@/data/templates";
import { CustomView } from "@/views/Custom";
import { RankView } from "@/views/Rank";
import { SongsView } from "@/views/Songs";
import { FeaturedTemplateFeed, VideoDetailView } from "@/views/TemplateMedia";

export type PreviewPlatform = "android" | "iphone";
export type PreviewSource = "draft" | "published";
export type PreviewFocus =
  | { kind: "template"; id: string }
  | { kind: "photo-effect"; id: string }
  | { kind: "photo-category"; id: string };

export interface CatalogValidationState {
  state: "idle" | "checking" | "valid" | "invalid";
  message?: string;
  hash?: string;
}

type PreviewPage = "featured" | "songs" | "rank" | "custom";
type PreviewPageRequest = { page: PreviewPage; nonce: number };
type PreviewState = "editing" | "unsaved" | "draft" | "synced" | "published";
type AssetState = "idle" | "loading" | "ready" | "error";

const PAGES: Array<{ id: PreviewPage; label: string }> = [
  { id: "featured", label: "精选" },
  { id: "songs", label: "视频" },
  { id: "rank", label: "推荐" },
  { id: "custom", label: "图片" },
];

const CLIENT_TABS = [
  { key: "rank" as const, icon: Trophy, label: "推荐" },
  { key: "songs" as const, icon: Music2, label: "视频玩法" },
  { key: "featured" as const, icon: ThumbsUp, label: "精选" },
  { key: "custom" as const, icon: WandSparkles, label: "百变图片" },
  { key: "mine" as const, icon: UserRound, label: "我的" },
];

const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const VIDEO_EXTENSIONS = [".mp4", ".webm"];
const SAFE_ASSET_PREFIXES = ["/templates/", "/effects/", "/banners/", "/plays/", "/avatars/"];

function isSafePreviewAsset(value: string | undefined, kind: "image" | "video") {
  const normalized = String(value || "").trim();
  if (!normalized.startsWith("/") || normalized.startsWith("//") || /[\\%?#\r\n]/.test(normalized)) return false;
  let pathname = "";
  try {
    const parsed = new URL(normalized, window.location.origin);
    if (parsed.origin !== window.location.origin) return false;
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return false;
  }
  if (pathname.includes("..") || !SAFE_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  const extensions = kind === "video" ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  return extensions.some((extension) => pathname.endsWith(extension));
}

function safeCatalog(catalog: RuntimeCatalog) {
  return projectCatalogForClient({
    ...catalog,
    templates: catalog.templates.map((template) => ({
      ...template,
      cover: isSafePreviewAsset(template.cover, "image") ? template.cover : EMPTY_IMAGE,
      previewVideo: template.previewVideo && isSafePreviewAsset(template.previewVideo, "video") ? template.previewVideo : undefined,
    })),
    photoCategories: catalog.photoCategories.map((category) => ({
      ...category,
      cover: isSafePreviewAsset(category.cover, "image") ? category.cover : EMPTY_IMAGE,
    })),
    photoEffects: catalog.photoEffects.map((effect) => ({
      ...effect,
      preview: isSafePreviewAsset(effect.preview, "image") ? effect.preview : EMPTY_IMAGE,
    })),
  });
}

function changedEntries<T extends { id: string }>(left: T[], right: T[]) {
  const leftById = new Map(left.map((item) => [item.id, JSON.stringify(item)]));
  return right.filter((item) => leftById.get(item.id) !== JSON.stringify(item)).length;
}

function catalogDiff(published: RuntimeCatalog, draft: RuntimeCatalog) {
  return {
    settings: JSON.stringify(published.settings) === JSON.stringify(draft.settings) ? 0 : 1,
    theme: Object.keys(draft.theme).filter((key) => published.theme[key as keyof RuntimeCatalog["theme"]] !== draft.theme[key as keyof RuntimeCatalog["theme"]]).length,
    templates: changedEntries(published.templates, draft.templates),
    categories: changedEntries(published.photoCategories, draft.photoCategories),
    effects: changedEntries(published.photoEffects, draft.photoEffects),
  };
}

function focusedAsset(catalog: RuntimeCatalog, focus: PreviewFocus | null) {
  if (focus?.kind === "template") {
    const template = catalog.templates.find((item) => item.id === focus.id);
    if (!template) return null;
    if (!isSafePreviewAsset(template.cover, "image")) return { url: template.cover, kind: "image" as const };
    if (template.previewVideo && !isSafePreviewAsset(template.previewVideo, "video")) return { url: template.previewVideo, kind: "video" as const };
    if (template.previewVideo) return { url: template.previewVideo, kind: "video" as const };
    return { url: template.cover, kind: "image" as const };
  }
  if (focus?.kind === "photo-effect") {
    const effect = catalog.photoEffects.find((item) => item.id === focus.id);
    return effect?.preview ? { url: effect.preview, kind: "image" as const } : null;
  }
  if (focus?.kind === "photo-category") {
    const category = catalog.photoCategories.find((item) => item.id === focus.id);
    return category?.cover ? { url: category.cover, kind: "image" as const } : null;
  }
  const template = catalog.templates.find((item) => item.enabled !== false && item.media === "video" && item.previewVideo);
  return template?.previewVideo ? { url: template.previewVideo, kind: "video" as const } : null;
}

function MediaProbe({ asset, onState }: { asset: ReturnType<typeof focusedAsset>; onState: (state: AssetState) => void }) {
  const url = asset?.url;
  const kind = asset?.kind;
  useEffect(() => {
    if (!url || !kind) onState("idle");
    else if (!isSafePreviewAsset(url, kind)) onState("error");
    else onState("loading");
  }, [kind, onState, url]);

  if (!url || !kind || !isSafePreviewAsset(url, kind)) return null;
  return kind === "video"
    ? <video key={url} className="live-preview-probe" src={url} muted preload="metadata" onLoadedData={() => onState("ready")} onError={() => onState("error")} />
    : <img key={url} className="live-preview-probe" src={url} alt="" onLoad={() => onState("ready")} onError={() => onState("error")} />;
}

function DeviceStatusBar({ platform }: { platform: PreviewPlatform }) {
  return (
    <div className="live-device-status" aria-hidden="true">
      <span>9:41</span>
      {platform === "iphone" ? <i className="live-device-island" /> : <i className="live-device-camera" />}
      <span>{platform === "iphone" ? "5G  ▮▮▮" : "▮▮▮  5G  82%"}</span>
    </div>
  );
}

function ClientPreviewSurface({ catalog, focus, platform, assetState, pageRequest }: {
  catalog: RuntimeCatalog;
  focus: PreviewFocus | null;
  platform: PreviewPlatform;
  assetState: AssetState;
  pageRequest: PreviewPageRequest | null;
}) {
  const initialPage = pageRequest?.page || (focus?.kind === "photo-effect" || focus?.kind === "photo-category" ? "custom" : focus?.kind === "template" ? "songs" : "featured");
  const [page, setPage] = useState<PreviewPage>(initialPage);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(focus?.kind === "template" ? focus.id : null);
  const [returnTo, setReturnTo] = useState<PreviewPage>("songs");
  const [safetyNotice, setSafetyNotice] = useState(false);
  const projected = useMemo(() => safeCatalog(catalog), [catalog]);
  const videos = useMemo(() => sortVideoTemplatesNewestFirst(projected.templates
    .filter((item) => item.media === "video" && Boolean(item.previewVideo))), [projected.templates]);
  const featured = useMemo(() => videos.filter((item) => item.featured !== false), [videos]);
  const selectedTemplate = selectedTemplateId ? videos.find((item) => item.id === selectedTemplateId) : undefined;
  const focusedCategory = useMemo<PhotoEffectCategoryId | undefined>(() => {
    if (focus?.kind === "photo-category") return focus.id as PhotoEffectCategoryId;
    if (focus?.kind === "photo-effect") return projected.photoEffects.find((item) => item.id === focus.id)?.categoryId;
    return undefined;
  }, [focus, projected.photoEffects]);

  const openDetail = (template: Template, from: PreviewPage) => {
    setSelectedTemplateId(template.id);
    setReturnTo(from);
  };
  const blockSideEffect = () => {
    setSafetyNotice(true);
    window.setTimeout(() => setSafetyNotice(false), 2400);
  };
  const navigate = (next: PreviewPage) => {
    setSelectedTemplateId(null);
    setPage(next);
  };
  const activePage = selectedTemplate ? returnTo : page;
  const style = {
    "--ly-accent": projected.theme.accent,
    "--ly-secondary": projected.theme.secondary,
    "--ly-background": projected.theme.background,
    "--ly-surface": projected.theme.surface,
    "--ly-text": projected.theme.text,
  } as CSSProperties;

  return (
    <div className="live-preview-device" data-platform={platform} style={style}>
      <DeviceStatusBar platform={platform} />
      <div className="app-client-surface live-preview-client">
        {!projected.settings.generationEnabled && (
          <div className="live-preview-maintenance" role="status">{projected.settings.maintenanceNotice || "创作服务维护中，请稍后再试"}</div>
        )}
        <div className="live-preview-view" key={`${selectedTemplate ? "detail" : page}-${focus?.id || "main"}`}>
          {selectedTemplate ? (
            <VideoDetailView key={`${selectedTemplate.id}:${selectedTemplate.cover}:${selectedTemplate.previewVideo || ""}`} template={selectedTemplate} onBack={() => setSelectedTemplateId(null)} onUse={blockSideEffect} initialSoundEnabled={false} />
          ) : (
            <>
              {page === "featured" && <FeaturedTemplateFeed templates={featured} onSelect={blockSideEffect} initialSoundEnabled={false} />}
              {page === "songs" && <SongsView templates={videos} credits={12} onSelect={(template) => openDetail(template, "songs")} />}
              {page === "rank" && <RankView templates={videos} onSelect={(template) => openDetail(template, "rank")} />}
              {page === "custom" && (
                <CustomView
                  categories={projected.photoCategories}
                  photoEffects={projected.photoEffects}
                  captionEnabled={projected.settings.captionEnabled}
                  focusCategoryId={focusedCategory}
                  onSelect={blockSideEffect}
                  onCaption={blockSideEffect}
                  networkEnabled={false}
                />
              )}
            </>
          )}
        </div>
        <nav className="tab-bar live-preview-tabbar" aria-label="预览主导航">
          {CLIENT_TABS.map((tab) => {
            const Icon = tab.icon;
            const selected = tab.key === activePage;
            const disabled = tab.key === "mine";
            return (
              <button
                type="button"
                key={tab.key}
                disabled={disabled}
                aria-current={selected ? "page" : undefined}
                onClick={() => { if (tab.key !== "mine") navigate(tab.key); }}
                className={selected ? "is-active" : ""}
                style={selected ? { color: projected.theme.accent } : undefined}
              >
                <Icon size={22} strokeWidth={selected ? 2.3 : 1.8} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
        {safetyNotice && <div className="live-preview-safety-toast" role="status"><ShieldCheck size={15} />预览已拦截上传、生成和扣次</div>}
        {assetState === "error" && <div className="live-preview-asset-error" role="alert"><CircleAlert size={18} />素材无法加载，请检查入库路径</div>}
      </div>
      {platform === "iphone" ? <div className="live-device-home" aria-hidden="true" /> : <div className="live-device-android-nav" aria-hidden="true"><i /><i /><i /></div>}
    </div>
  );
}

function stateDetails(state: PreviewState, revision: number, version: number) {
  if (state === "editing") return { label: "正在编辑 · 未应用", tone: "warn" };
  if (state === "unsaved") return { label: "已应用 · 未保存", tone: "warn" };
  if (state === "draft") return { label: `草稿 r${revision} · 待发布`, tone: "draft" };
  if (state === "synced") return { label: `草稿 r${revision} · 与线上一致`, tone: "good" };
  return { label: `线上 v${version} · 已同步`, tone: "good" };
}

export function LivePreview({
  draftCatalog,
  publishedCatalog,
  focus,
  editorDirty,
  localChanged,
  workspaceDirty,
  revision,
  version,
  validation,
  source,
  onSourceChange,
  onClose,
}: {
  draftCatalog: RuntimeCatalog;
  publishedCatalog: RuntimeCatalog;
  focus: PreviewFocus | null;
  editorDirty: boolean;
  localChanged: boolean;
  workspaceDirty: boolean;
  revision: number;
  version: number;
  validation: CatalogValidationState;
  source: PreviewSource;
  onSourceChange: (source: PreviewSource) => void;
  onClose: () => void;
}) {
  const [platform, setPlatform] = useState<PreviewPlatform>("android");
  const [assetState, setAssetState] = useState<AssetState>("idle");
  const [pageRequest, setPageRequest] = useState<PreviewPageRequest | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(.7);
  const selectedCatalog = source === "draft" ? draftCatalog : publishedCatalog;
  const previewState: PreviewState = source === "published" ? "published" : editorDirty ? "editing" : localChanged ? "unsaved" : workspaceDirty ? "draft" : "synced";
  const state = stateDetails(previewState, revision, version);
  const displayedValidation: CatalogValidationState = source === "published" ? { state: "valid", message: "线上版本已发布校验" } : validation;
  const diff = useMemo(() => catalogDiff(publishedCatalog, draftCatalog), [draftCatalog, publishedCatalog]);
  const asset = useMemo(() => focusedAsset(selectedCatalog, focus), [focus, selectedCatalog]);
  const hiddenFocus = focus?.kind === "template"
    ? selectedCatalog.templates.find((item) => item.id === focus.id)?.enabled === false
    : focus?.kind === "photo-effect"
      ? selectedCatalog.photoEffects.find((item) => item.id === focus.id)?.enabled === false
      : focus?.kind === "photo-category"
        ? selectedCatalog.photoCategories.find((item) => item.id === focus.id)?.enabled === false
        : false;
  const dimensions = platform === "iphone" ? { width: 390, height: 844 } : { width: 412, height: 915 };

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => setScale(Math.min(1, (stage.clientWidth - 8) / dimensions.width, (stage.clientHeight - 8) / dimensions.height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [dimensions.height, dimensions.width]);

  const diffItems = [
    ["模板", diff.templates],
    ["图片效果", diff.effects],
    ["分区", diff.categories],
    ["配色", diff.theme],
    ["全局", diff.settings],
  ] as const;

  return (
    <aside
      className="live-preview-dock"
      aria-label="客户端实时预览"
      data-qa="live-preview"
      data-platform={platform}
      data-preview-state={previewState}
      data-asset-state={assetState}
    >
      <header className="live-preview-head">
        <div><span>CLIENT PREVIEW</span><h2>客户端实时预览</h2></div>
        <button type="button" className="admin-icon-button" onClick={onClose} aria-label="关闭实时预览" title="关闭预览"><X size={18} /></button>
      </header>

      <div className="live-preview-controls">
        <div className="live-preview-segment" role="group" aria-label="设备平台">
          <button type="button" aria-pressed={platform === "android"} className={platform === "android" ? "is-active" : ""} onClick={() => setPlatform("android")}><Smartphone size={14} />Android</button>
          <button type="button" aria-pressed={platform === "iphone"} className={platform === "iphone" ? "is-active" : ""} onClick={() => setPlatform("iphone")}><Smartphone size={14} />iPhone 模拟</button>
        </div>
        <div className="live-preview-segment" role="group" aria-label="预览版本">
          <button type="button" aria-pressed={source === "draft"} className={source === "draft" ? "is-active" : ""} onClick={() => onSourceChange("draft")}>当前草稿</button>
          <button type="button" aria-pressed={source === "published"} className={source === "published" ? "is-active" : ""} onClick={() => onSourceChange("published")}>线上 v{version}</button>
        </div>
        <div className="live-preview-pages" role="tablist" aria-label="预览页面">
          {PAGES.map((item) => (
            <button
              type="button"
              key={item.id}
              role="tab"
              aria-selected={pageRequest?.page === item.id}
              className={pageRequest?.page === item.id ? "is-active" : ""}
              onClick={() => setPageRequest({ page: item.id, nonce: Date.now() })}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="live-preview-state-row">
        <span className={`live-preview-state is-${state.tone}`}><i />{state.label}</span>
        <span className={`live-preview-validation is-${displayedValidation.state}`}>
          {displayedValidation.state === "checking" ? "正在校验" : displayedValidation.state === "valid" ? <><Check size={13} />校验通过</> : displayedValidation.state === "invalid" ? <><CircleAlert size={13} />校验阻断</> : "等待校验"}
        </span>
      </div>
      {displayedValidation.state === "invalid" && <p className="live-preview-validation-message" role="alert">{displayedValidation.message}</p>}
      {hiddenFocus && <p className="live-preview-hidden-note">当前内容已设为隐藏，发布后不会出现在客户端。</p>}

      <div className="live-preview-stage" ref={stageRef}>
        <div className="live-preview-scaled" style={{ width: dimensions.width, height: dimensions.height, transform: `translateX(-50%) scale(${scale})` }}>
          <ClientPreviewSurface
            key={`${source}:${source === "draft" ? `${focus?.kind || "none"}:${focus?.id || "none"}` : "online"}:${pageRequest?.nonce || 0}`}
            catalog={selectedCatalog}
            focus={source === "draft" ? focus : null}
            platform={platform}
            assetState={assetState}
            pageRequest={pageRequest}
          />
        </div>
      </div>

      <footer className="live-preview-foot">
        <div className="live-preview-diff" aria-label="草稿差异摘要">
          {diffItems.map(([label, count]) => <span className={count ? "is-changed" : ""} key={label}>{label}<b>{count}</b></span>)}
        </div>
        <p><ShieldCheck size={13} />后台预览不会上传照片、调用模型、生成作品或扣除次数</p>
      </footer>
      <MediaProbe asset={asset} onState={setAssetState} />
    </aside>
  );
}
