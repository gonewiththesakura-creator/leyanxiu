import { useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowLeft, ChevronRight, Volume2, VolumeX } from "lucide-react";
import type { Template } from "@/data/templates";
import { APP_ACCOUNT_ONLY } from '@/lib/account-only';

export function TemplateVideoPreview({ template, suspended = false }: { template: Template; suspended?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;

    const updatePlayback = (isVisible: boolean) => {
      if (!active) return;
      if (isVisible && !suspended) {
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) updatePlayback(entry.isIntersecting);
      },
      { threshold: 0.35 },
    );

    observer.observe(video);
    const rect = video.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    updatePlayback(visibleHeight >= rect.height * 0.35);

    return () => {
      active = false;
      observer.disconnect();
      video.pause();
    };
  }, [suspended]);

  return (
    <>
      <img
        src={template.cover}
        alt={template.name}
        className={`absolute inset-0 h-full w-full object-cover transition duration-500 ${isReady && !hasError ? "opacity-0" : "opacity-100"}`}
      />
      {!hasError && (
        <video
          ref={videoRef}
          src={template.previewVideo}
          poster={template.cover}
          muted
          loop
          playsInline
          autoPlay
          disablePictureInPicture
          preload="metadata"
          onPlaying={() => setIsReady(true)}
          onError={() => {
            setHasError(true);
            setIsReady(false);
          }}
          className={`absolute inset-0 h-full w-full object-cover transition duration-500 ${isReady ? "opacity-100" : "opacity-0"}`}
          aria-hidden="true"
        />
      )}
      <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[9px] font-semibold text-white backdrop-blur">AI 模板</span>
    </>
  );
}

function FeaturedTemplateSlide({
  template,
  active,
  preload,
  suspended,
  soundEnabled,
  onSoundChange,
  onSelect,
}: {
  template: Template;
  active: boolean;
  preload: "auto" | "metadata";
  suspended: boolean;
  soundEnabled: boolean;
  onSoundChange: (enabled: boolean) => void;
  onSelect: (template: Template) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let mounted = true;

    video.muted = !soundEnabled || !active || suspended;
    if (!active || suspended) {
      video.pause();
      return () => {
        mounted = false;
        video.pause();
      };
    }

    video.muted = !soundEnabled;
    void video.play().then(() => {
      if (mounted) setSoundBlocked(false);
    }).catch(() => {
      if (!mounted) return;
      if (soundEnabled) {
        video.muted = true;
        setSoundBlocked(true);
        void video.play().catch(() => undefined);
      }
    });

    return () => {
      mounted = false;
      video.pause();
    };
  }, [active, soundEnabled, suspended]);

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video || !active || suspended) return;

    const nextEnabled = soundBlocked ? true : !soundEnabled;
    onSoundChange(nextEnabled);
    setSoundBlocked(false);
    video.muted = !nextEnabled;
    void video.play().then(() => {
      setSoundBlocked(false);
    }).catch(() => {
      if (nextEnabled) setSoundBlocked(true);
    });
  };

  const soundLabel = soundEnabled
    ? soundBlocked ? "重试开启声音" : "关闭声音"
    : "开启声音";
  const actionLabel = template.group === "dancing"
    ? "让照片跳起来"
    : template.group === "quote"
      ? "让照片开口说"
      : "让照片唱起来";

  return (
    <article className="featured-card group" aria-current={active ? "true" : undefined}>
      <img
        src={template.cover}
        alt=""
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isReady && !hasError ? "opacity-0" : "opacity-100"}`}
      />
      {!hasError && (
        <video
          ref={videoRef}
          src={template.previewVideo}
          poster={template.cover}
          muted={!soundEnabled || !active || suspended}
          loop
          playsInline
          disablePictureInPicture
          preload={preload}
          onPlaying={() => setIsReady(true)}
          onError={() => {
            setHasError(true);
            setIsReady(false);
          }}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isReady ? "opacity-100" : "opacity-0"}`}
          aria-hidden="true"
        />
      )}

      <div className="featured-card-scrim absolute inset-0" />
      <span className="absolute left-5 top-0 mt-[max(22px,env(safe-area-inset-top))] rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-semibold text-white backdrop-blur-md">AI 模板演示</span>
      <div className="absolute right-5 top-0 pt-[max(22px,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={toggleSound}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition hover:bg-black/60"
          aria-label={soundLabel}
          aria-pressed={soundEnabled}
          title={soundLabel}
        >
          {soundEnabled && !soundBlocked ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </button>
      </div>

      <div className="absolute inset-x-5 bottom-5 text-white">
        <p className="text-[12px] font-medium text-white/75">{template.category}</p>
        <h3 className="mt-1.5 text-[27px] font-semibold leading-tight">{template.name}</h3>
        <p className="featured-description mt-1.5 text-[13px] leading-relaxed text-white/80">{template.description}</p>
        <button
          type="button"
          onClick={() => onSelect(template)}
          disabled={APP_ACCOUNT_ONLY}
          className="soft-press mt-5 flex min-h-[52px] w-full items-center justify-center gap-2 rounded-[8px] px-4 text-[16px] font-semibold text-white shadow-[0_10px_26px_rgba(242,59,209,.28)]"
          style={{ backgroundColor: "var(--ly-accent)" }}
        >
          {APP_ACCOUNT_ONLY ? '模板预览 · 创作暂未开放' : actionLabel}
          <ChevronRight size={18} />
        </button>
      </div>
    </article>
  );
}

export function FeaturedTemplateFeed({
  templates,
  onSelect,
  suspended = false,
  initialSoundEnabled = true,
}: {
  templates: Template[];
  onSelect: (template: Template) => void;
  suspended?: boolean;
  initialSoundEnabled?: boolean;
}) {
  const [feedRef, emblaApi] = useEmblaCarousel({
    axis: "y",
    loop: true,
    dragFree: false,
    skipSnaps: false,
    slidesToScroll: 1,
    duration: 28,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(initialSoundEnabled);
  const wheelLocked = useRef(false);

  useEffect(() => {
    if (!emblaApi) return;

    const updateActive = () => setActiveIndex(emblaApi.selectedScrollSnap());
    updateActive();
    emblaApi.on("select", updateActive);
    emblaApi.on("reInit", updateActive);

    return () => {
      emblaApi.off("select", updateActive);
      emblaApi.off("reInit", updateActive);
    };
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    const viewport = emblaApi.rootNode();
    let releaseTimer = 0;

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 8) return;
      event.preventDefault();
      if (wheelLocked.current) return;

      wheelLocked.current = true;
      if (event.deltaY > 0) emblaApi.scrollNext();
      else emblaApi.scrollPrev();

      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        wheelLocked.current = false;
      }, 560);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
      window.clearTimeout(releaseTimer);
      wheelLocked.current = false;
    };
  }, [emblaApi]);

  if (templates.length === 0) {
    return (
      <div className="flex h-full min-h-0 w-full items-center justify-center px-5 pb-24" style={{ color: "var(--ly-text)", background: "var(--ly-background)" }}>
        <div className="w-full rounded-[8px] border border-dashed border-current/20 p-6 text-center" style={{ background: "var(--ly-surface)" }}>
          <p className="text-base font-semibold">暂无精选模板</p>
          <p className="mt-1 text-sm opacity-60">当前没有可播放的视频模板</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" style={{ background: "var(--ly-background)" }}>
      <h2 className="sr-only">精选视频模板</h2>
      <div ref={feedRef} className="featured-feed mb-[78px] min-h-0 flex-1 overflow-hidden" aria-label={`精选视频模板，第 ${activeIndex + 1} 个，共 ${templates.length} 个`} role="region">
        <div className="featured-feed-container">
          {templates.map((template, index) => (
            <div key={`${template.id}:${template.cover}:${template.previewVideo || ""}`} data-featured-slide className="featured-slide">
              <FeaturedTemplateSlide
                template={template}
                active={activeIndex === index}
                preload={Math.abs(index - activeIndex) <= 1 ? "auto" : "metadata"}
                suspended={suspended}
                soundEnabled={soundEnabled}
                onSoundChange={setSoundEnabled}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function VideoDetailView({
  template,
  onBack,
  onUse,
  initialSoundEnabled = true,
}: {
  template: Template;
  onBack: () => void;
  onUse: () => void;
  initialSoundEnabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [soundEnabled, setSoundEnabled] = useState(initialSoundEnabled);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || hasError) return;
    let mounted = true;

    video.muted = !soundEnabled;
    void video.play().then(() => {
      if (mounted) setSoundBlocked(false);
    }).catch(() => {
      if (!mounted) return;
      video.muted = true;
      setSoundBlocked(true);
      void video.play().catch(() => undefined);
    });

    return () => {
      mounted = false;
      video.pause();
    };
  }, [hasError, soundEnabled]);

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextEnabled = soundBlocked ? true : !soundEnabled;
    setSoundEnabled(nextEnabled);
    video.muted = !nextEnabled;
    void video.play().then(() => setSoundBlocked(false)).catch(() => setSoundBlocked(nextEnabled));
  };

  const actionLabel = template.group === "dancing"
    ? "用我的照片跳起来"
    : template.group === "quote"
      ? "用我的照片说这句"
      : "用我的照片唱这首";

  return (
    <div className="relative h-full overflow-hidden bg-black pb-[78px] text-white">
      <img src={template.cover} alt="" className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isReady && !hasError ? "opacity-0" : "opacity-100"}`} />
      {!hasError && (
        <video
          ref={videoRef}
          src={template.previewVideo}
          poster={template.cover}
          loop
          playsInline
          autoPlay
          disablePictureInPicture
          preload="auto"
          onPlaying={() => setIsReady(true)}
          onError={() => {
            setHasError(true);
            setIsReady(false);
          }}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${isReady ? "opacity-100" : "opacity-0"}`}
        />
      )}
      <div className="featured-card-scrim absolute inset-0" />

      <div className="absolute inset-x-5 top-0 flex items-center justify-between pt-[max(18px,env(safe-area-inset-top))]">
        <button type="button" onClick={onBack} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md" aria-label="返回">
          <ArrowLeft size={21} />
        </button>
        <button type="button" onClick={toggleSound} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md" aria-label={soundBlocked ? "点一下开启声音" : soundEnabled ? "关闭声音" : "开启声音"}>
          {soundEnabled && !soundBlocked ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </button>
      </div>
      <span className="absolute left-1/2 top-0 mt-[max(27px,env(safe-area-inset-top))] -translate-x-1/2 rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-semibold text-white backdrop-blur-md">AI 模板演示</span>

      <div className="absolute inset-x-5 bottom-[98px]">
        <p className="text-xs font-medium text-white/70">{template.category}</p>
        <h1 className="mt-1 text-[28px] font-semibold leading-tight">{template.name}</h1>
        <p className="mt-2 text-sm leading-relaxed text-white/75">{template.description}</p>
        {soundBlocked && <p className="mt-2 text-xs font-medium text-[#72f5d1]">点右上角开启模板声音</p>}
        <button type="button" onClick={onUse} disabled={APP_ACCOUNT_ONLY} className="soft-press mt-5 flex min-h-[54px] w-full items-center justify-center gap-2 rounded-[8px] px-4 text-[16px] font-semibold text-white shadow-[0_12px_28px_rgba(242,59,209,.3)]" style={{ backgroundColor: "var(--ly-accent)" }}>
          {APP_ACCOUNT_ONLY ? '模板预览 · 创作暂未开放' : actionLabel}<ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
