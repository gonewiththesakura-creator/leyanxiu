import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Template } from "@/data/templates";
import { sortVideoTemplatesNewestFirst, TEMPLATES } from "@/data/templates";
import { cachedCatalog, DEFAULT_RUNTIME_CATALOG, fetchRuntimeCatalog } from "@/data/runtimeCatalog";
import { SongsView } from "@/views/Songs";
import { RankView } from "@/views/Rank";
import { FeaturedTemplateFeed, VideoDetailView } from "@/views/TemplateMedia";
import { CustomView } from "@/views/Custom";
import { PlayView } from "@/views/Play";
import { UploadView, GeneratingView, ResultView } from "@/views/Flow";
import { MineView, WorksView } from "@/views/Mine";
import { PurchaseView } from "@/views/Purchase";
import { getCredits } from "@/lib/growth";
import { CLOSED_TEST_INVITE_REQUIRED, getServerEntitlements, prepareAuthenticatedSession, recordAccountTestConsent, resumePendingCreation } from "@/lib/api";
import { ShieldCheck, Trophy, Music2, ThumbsUp, WandSparkles, UserRound } from "lucide-react";
import { App as NativeApp } from "@capacitor/app";
import { IS_NATIVE_APP } from "@/lib/native";
import { PrivacyGate } from "@/views/PrivacyGate";
import { acceptPrivacy, hasAcceptedPrivacy } from "@/lib/privacy";
import { APP_ACCOUNT_ONLY, ACCOUNT_ONLY_NOTICE } from '@/lib/account-only';

type MainTab = "rank" | "songs" | "featured" | "custom" | "mine";

type View =
  | { name: MainTab }
  | { name: "caption"; returnTo: MainTab }
  | { name: "video-detail"; template: Template; returnTo: MainTab }
  | { name: "upload"; template: Template; returnTo: MainTab }
  | { name: "generating"; template: Template; photo: string; returnTo: MainTab }
  | { name: "result"; template: Template; result: string; kind: "video" | "image"; assetId?: string; returnTo: MainTab }
  | { name: "works" }
  | { name: "purchase" };

type PrivacyMode = "notice" | "browse" | "accepted";

const NAV_ITEMS: Array<{ key: MainTab; icon: typeof Trophy; label: string }> = [
  { key: "rank", icon: Trophy, label: "推荐" },
  { key: "songs", icon: Music2, label: "视频玩法" },
  { key: "featured", icon: ThumbsUp, label: "精选" },
  { key: "custom", icon: WandSparkles, label: "百变图片" },
  { key: "mine", icon: UserRound, label: "我的" },
];

export default function App() {
  const [onlineCatalog, setCatalog] = useState(cachedCatalog);
  const [view, setView] = useState<View>({ name: "featured" });
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>(() => hasAcceptedPrivacy() && !CLOSED_TEST_INVITE_REQUIRED ? "accepted" : "notice");
  const [pendingTemplate, setPendingTemplate] = useState<{ template: Template; returnTo: MainTab } | null>(null);
  const privacyAccepted = privacyMode === "accepted";
  // Cached online media must not load before consent, including after a restart.
  const catalog = privacyAccepted && !APP_ACCOUNT_ONLY ? onlineCatalog : DEFAULT_RUNTIME_CATALOG;
  const [credits, setCredits] = useState(() => privacyAccepted ? getCredits() : 0);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [recovering, setRecovering] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const recoveryStarted = useRef(false);
  const videoTemplates = useMemo(() => sortVideoTemplatesNewestFirst(catalog.templates
    .filter((template) => template.enabled !== false && template.media === "video" && Boolean(template.previewVideo))), [catalog.templates]);
  const featuredTemplates = useMemo(() => videoTemplates.filter((template) => template.featured !== false), [videoTemplates]);

  useEffect(() => {
    if (!privacyAccepted || APP_ACCOUNT_ONLY) return;
    const controller = new AbortController();
    let timer = 0;
    const refreshCatalog = () => {
      void fetchRuntimeCatalog(controller.signal).then((nextCatalog) => {
        if (!controller.signal.aborted) setCatalog(nextCatalog);
      }).catch(() => undefined);
    };
    refreshCatalog();
    const handleVisible = () => { if (document.visibilityState === "visible") refreshCatalog(); };
    const handleOnline = () => refreshCatalog();
    document.addEventListener("visibilitychange", handleVisible);
    window.addEventListener("online", handleOnline);
    timer = window.setInterval(refreshCatalog, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisible);
      window.removeEventListener("online", handleOnline);
    };
  }, [privacyAccepted]);

  useEffect(() => {
    document.title = catalog.settings.productName;
  }, [catalog.settings.productName]);

  useEffect(() => {
    if (!privacyAccepted) return;
    void getServerEntitlements().then(setCredits).catch(() => undefined);
  }, [privacyAccepted]);

  useEffect(() => {
    if (!privacyAccepted || APP_ACCOUNT_ONLY || recoveryStarted.current) return;
    recoveryStarted.current = true;
    queueMicrotask(() => setRecovering(true));
    void resumePendingCreation()
      .then((result) => {
        if (!result) return;
        const template = catalog.templates.find((item) => item.id === result.templateId) || TEMPLATES.find((item) => item.id === result.templateId);
        if (!template) throw new Error("已完成的任务对应模板已下线，请到我的作品查看");
        setView({
          name: "result",
          template,
          result: result.url,
          kind: result.kind,
          assetId: result.assetId,
          returnTo: template.media === "video" ? "featured" : "custom",
        });
      })
      .catch((error) => setRecoveryMessage(error instanceof Error ? error.message : "上次任务恢复失败"))
      .finally(() => setRecovering(false));
  }, [catalog.templates, privacyAccepted]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!IS_NATIVE_APP) return;
    const backListener = NativeApp.addListener("backButton", () => {
      setView((current) => {
        const overlayBack = new Event("leyanxiu:native-back", { cancelable: true });
        if (!document.dispatchEvent(overlayBack)) return current;
        if (current.name === "generating") return current;
        if (current.name === "caption" || current.name === "video-detail" || current.name === "upload" || current.name === "result") {
          return { name: current.returnTo };
        }
        if (current.name === "works" || current.name === "purchase") return { name: "mine" };
        void NativeApp.exitApp();
        return current;
      });
    });
    const stateListener = NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) document.querySelectorAll("video").forEach((video) => video.pause());
    });
    return () => {
      void backListener.then((listener) => listener.remove());
      void stateListener.then((listener) => listener.remove());
    };
  }, []);

  const goTo = (name: MainTab) => setView({ name });

  const selectTemplate = (template: Template, returnTo: MainTab) => {
    if (APP_ACCOUNT_ONLY) return;
    if (!catalog.settings.generationEnabled) {
      window.alert(catalog.settings.maintenanceNotice || "创作服务维护中，请稍后再试");
      return;
    }
    if (!privacyAccepted) {
      setPendingTemplate({ template, returnTo });
      setPrivacyMode("notice");
      return;
    }
    setView({ name: "upload", template, returnTo });
  };

  const openVideoDetail = (template: Template, returnTo: MainTab) => {
    setView({ name: "video-detail", template, returnTo });
  };

  const startGenerate = (template: Template, photo: string, returnTo: MainTab) => {
    if (APP_ACCOUNT_ONLY) return;
    setView({ name: "generating", template, photo, returnTo });
  };

  const inFlow = view.name === "upload" || view.name === "generating" || view.name === "result" || view.name === "purchase";
  const activeTab: MainTab = view.name === "caption" || view.name === "video-detail"
    ? view.returnTo
    : view.name === "works" || view.name === "purchase"
      ? "mine"
      : view.name === "upload" || view.name === "generating" || view.name === "result"
        ? view.returnTo
        : view.name;

  if (privacyMode === "notice") {
    return (
      <PrivacyGate
        productName={catalog.settings.productName}
        onBrowse={() => {
          setPendingTemplate(null);
          setPrivacyMode("browse");
        }}
        onAccept={async (inviteCode) => {
          await prepareAuthenticatedSession(inviteCode);
          await recordAccountTestConsent();
          acceptPrivacy();
          setCredits(getCredits());
          setPrivacyMode("accepted");
          if (pendingTemplate && !APP_ACCOUNT_ONLY) {
            setView({ name: "upload", template: pendingTemplate.template, returnTo: pendingTemplate.returnTo });
            setPendingTemplate(null);
          }
        }}
      />
    );
  }

  return (
    <div
      className={`app-shell flex min-h-[100dvh] items-center justify-center bg-[#171717] ${IS_NATIVE_APP ? "" : "min-[480px]:p-6"}`}
      style={{
        "--ly-accent": catalog.theme.accent,
        "--ly-secondary": catalog.theme.secondary,
        "--ly-background": catalog.theme.background,
        "--ly-surface": catalog.theme.surface,
        "--ly-text": catalog.theme.text,
      } as CSSProperties}
    >
      <div className={`app-client-surface relative h-[100dvh] w-full overflow-hidden ${IS_NATIVE_APP ? "" : "min-[480px]:h-[860px] min-[480px]:max-h-[94vh] min-[480px]:w-[430px] min-[480px]:rounded-[44px] min-[480px]:border-[8px] min-[480px]:border-[#2a2a2a] min-[480px]:shadow-[0_28px_70px_rgba(0,0,0,.48)]"}`}>
        <div className={`hidden h-7 items-center justify-between bg-black px-6 text-[11px] font-semibold text-white ${IS_NATIVE_APP ? "" : "min-[480px]:flex"}`}>
          <span>9:41</span>
          <div className="h-5 w-20 rounded-full bg-[#1d1d1f]" />
          <span>5G&nbsp;&nbsp;▮▮▮</span>
        </div>

        <div className={`relative h-full ${IS_NATIVE_APP ? "" : "min-[480px]:h-[calc(100%-28px)]"}`}>
          {!online && (
            <div role="status" className="absolute inset-x-3 top-[max(8px,env(safe-area-inset-top))] z-50 rounded-[8px] bg-[#fff4e5] px-4 py-2 text-center text-xs font-semibold text-[#8a5200] shadow-lg">
              当前网络不可用，已暂停在线生成
            </div>
          )}
          {!catalog.settings.generationEnabled && (
            <div role="status" className="absolute inset-x-3 top-[max(8px,env(safe-area-inset-top))] z-40 rounded-[8px] bg-[#fff4e5] px-4 py-2 text-center text-xs font-semibold text-[#8a5200] shadow-lg">
              {catalog.settings.maintenanceNotice || "创作服务维护中，请稍后再试"}
            </div>
          )}
          {(recovering || recoveryMessage) && (
            <div role="status" className={`absolute inset-x-3 top-[max(8px,env(safe-area-inset-top))] z-50 rounded-[8px] px-4 py-2 text-center text-xs font-semibold shadow-lg ${recoveryMessage ? "bg-[#fff4e5] text-[#8a5200]" : "bg-[#edf6ff] text-[#0055a4]"}`}>
              {recoveryMessage || "正在恢复上次生成任务，不会重复扣除次数"}
            </div>
          )}
          {!privacyAccepted && (
            <button
              type="button"
              onClick={() => setPrivacyMode("notice")}
              className="absolute left-3 top-[max(8px,env(safe-area-inset-top))] z-50 flex min-h-10 items-center gap-2 rounded-[8px] bg-white/92 px-3 text-xs font-semibold text-[#1d1d1f] shadow-lg backdrop-blur-xl"
            >
              <ShieldCheck size={15} className="text-[#0071e3]" /> {APP_ACCOUNT_ONLY ? '仅浏览 · 进入账号测试' : '仅浏览 · 开启创作'}
            </button>
          )}
          <div key={`${view.name}-${"template" in view ? view.template.id : "main"}`} className="view-enter h-full">
            {view.name === "rank" && <RankView templates={videoTemplates} onSelect={(template) => openVideoDetail(template, "rank")} />}
            {view.name === "songs" && <SongsView templates={videoTemplates} credits={credits} onSelect={(template) => openVideoDetail(template, "songs")} />}
            {view.name === "featured" && (
              <FeaturedTemplateFeed
                templates={featuredTemplates}
                onSelect={(template) => selectTemplate(template, "featured")}
              />
            )}
            {view.name === "custom" && (
              <CustomView
                categories={catalog.photoCategories}
                photoEffects={catalog.photoEffects}
                captionEnabled={!APP_ACCOUNT_ONLY && catalog.settings.captionEnabled}
                onSelect={(template) => selectTemplate(template, "custom")}
                onCaption={() => {
                  if (APP_ACCOUNT_ONLY) return;
                  if (privacyAccepted) setView({ name: "caption", returnTo: "custom" });
                  else setPrivacyMode("notice");
                }}
                networkEnabled={privacyAccepted && !APP_ACCOUNT_ONLY}
              />
            )}
            {view.name === "mine" && (
              <MineView
                credits={credits}
                onMake={() => goTo("custom")}
                onWorks={() => { if (!APP_ACCOUNT_ONLY) setView({ name: "works" }); }}
                onRefill={() => { if (privacyAccepted && !APP_ACCOUNT_ONLY) setView({ name: "purchase" }); }}
                privacyAccepted={privacyAccepted}
                onRequestPrivacy={() => setPrivacyMode("notice")}
                onPrivacyReset={() => {
                  setCredits(0);
                  setPrivacyMode("notice");
                  setView({ name: "featured" });
                }}
              />
            )}
            {!APP_ACCOUNT_ONLY && view.name === "caption" && <PlayView onBack={() => goTo(view.returnTo)} />}
            {!APP_ACCOUNT_ONLY && view.name === "purchase" && <PurchaseView onBack={() => goTo("mine")} onCredits={setCredits} />}
            {view.name === "video-detail" && (
              <VideoDetailView
                template={view.template}
                onBack={() => goTo(view.returnTo)}
                onUse={() => selectTemplate(view.template, view.returnTo)}
              />
            )}
            {!APP_ACCOUNT_ONLY && view.name === "upload" && (
              <UploadView
                template={view.template}
                credits={credits}
                onBack={() => goTo(view.returnTo)}
                onPurchase={() => setView({ name: "purchase" })}
                onGenerate={(photo, targetAge) => startGenerate(
                  targetAge ? { ...view.template, targetAge } : view.template,
                  photo,
                  view.returnTo,
                )}
              />
            )}
            {!APP_ACCOUNT_ONLY && view.name === "generating" && (
              <GeneratingView
                template={view.template}
                photo={view.photo}
                onDone={(result) => setView({ name: "result", template: view.template, result: result.url, kind: result.kind, assetId: result.assetId, returnTo: view.returnTo })}
                onError={(message) => {
                   void getServerEntitlements().then(setCredits).catch(() => undefined);
                  window.alert(message);
                  setView({ name: "upload", template: view.template, returnTo: view.returnTo });
                }}
              />
            )}
            {!APP_ACCOUNT_ONLY && view.name === "result" && (
              <ResultView
                template={view.template}
                result={view.result}
                kind={view.kind}
                assetId={view.assetId}
                onRestart={() => goTo(view.returnTo)}
                onFinish={() => goTo(view.returnTo)}
                onGoWorks={() => setView({ name: "works" })}
              />
            )}
            {!APP_ACCOUNT_ONLY && view.name === "works" && <WorksView onMake={() => goTo("custom")} />}
          </div>

          {APP_ACCOUNT_ONLY && privacyAccepted && view.name !== 'mine' && (
            <p role="status" className="pointer-events-none absolute inset-x-3 top-[max(8px,env(safe-area-inset-top))] z-30 rounded-lg bg-black/85 px-3 py-2 text-center text-xs leading-5 text-white">{ACCOUNT_ONLY_NOTICE}</p>
          )}

          {!inFlow && (
            <nav className="tab-bar absolute inset-x-0 bottom-0 z-20 grid h-[78px] grid-cols-5 border-t border-white/[.08] bg-[#101010]/95 pb-[max(6px,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-2xl" aria-label="主导航">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const selected = activeTab === item.key;
                return (
                  <button
                    type="button"
                    key={item.key}
                    onClick={() => goTo(item.key)}
                    aria-current={selected ? "page" : undefined}
                    className={`flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 transition-colors ${selected ? "" : "text-[#8b8b8f]"}`}
                    style={selected ? { color: catalog.theme.accent } : undefined}
                  >
                    <Icon size={22} strokeWidth={selected ? 2.3 : 1.8} />
                    <span className="text-[11px] font-medium">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
