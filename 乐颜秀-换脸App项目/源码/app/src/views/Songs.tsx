import { useEffect, useMemo, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronRight, Clock3, Gift, Play } from "lucide-react";
import type { Template } from "@/data/templates";
import { TemplateVideoPreview } from "@/views/TemplateMedia";

const VIDEO_CATEGORIES = ["热门", "欢唱经典", "男生", "女生", "经典台词", "照片跳舞"] as const;
type VideoCategory = typeof VIDEO_CATEGORIES[number];

const BANNERS = [
  {
    id: "classic",
    image: "/banners/classic-song-r13.webp",
    kicker: "欢唱经典",
    title: "熟悉的旋律，唱出你的故事",
    action: "唱这首",
    templateId: "jinqu",
  },
  {
    id: "dance",
    image: "/banners/photo-dance-r13.webp",
    kicker: "照片跳舞",
    title: "一张照片，轻松跳起来",
    action: "跳起来",
    templateId: "dance",
  },
  {
    id: "quote",
    image: "/banners/warm-quote-r13.webp",
    kicker: "经典台词",
    title: "把心里那句话，说给懂的人",
    action: "说这句",
    templateId: "quote",
  },
] as const;

function templatesForCategory(category: VideoCategory, templates: Template[]) {
  if (category === "热门") return templates;
  if (category === "欢唱经典") return templates.filter((item) => item.group === "singing");
  if (category === "经典台词") return templates.filter((item) => item.group === "quote");
  if (category === "照片跳舞") return templates.filter((item) => item.group === "dancing");
  if (category === "男生") return templates.filter((item) => item.audience === "male" || item.audience === "all");
  return templates.filter((item) => item.audience === "female" || item.audience === "all");
}

function templateAction(template: Template) {
  if (template.group === "dancing") return "跳起来";
  if (template.group === "quote") return "说这句";
  return "唱这首";
}

function VideoCard({ template, onSelect }: { template: Template; onSelect: (template: Template) => void }) {
  const isNew = Date.parse(template.publishedAt || "1970-01-01") >= Date.parse("2026-08-23T00:00:00+08:00");

  return (
    <button type="button" onClick={() => onSelect(template)} className="video-template-card soft-press min-w-0 text-left">
      <div className="relative aspect-[3/4] overflow-hidden rounded-[8px] bg-[#1b1b1d] ring-1 ring-white/[.08]">
        <TemplateVideoPreview template={template} />
        <div className="card-scrim absolute inset-0" />
        <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-2">
          {isNew ? <span className="rounded-full px-2 py-1 text-[10px] font-semibold text-white" style={{ backgroundColor: "var(--ly-accent)" }}>上新</span> : <span />}
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md" aria-hidden="true">
            <Play size={14} fill="currentColor" />
          </span>
        </div>
        <span className="absolute bottom-3 left-3 flex min-h-[38px] items-center justify-center rounded-[8px] px-3 text-[13px] font-semibold text-white shadow-lg" style={{ backgroundColor: "var(--ly-accent)" }}>
          {templateAction(template)}
        </span>
      </div>
      <h3 className="mt-2 truncate text-[15px] font-medium">{template.name}</h3>
    </button>
  );
}

export function SongsView({ templates, credits, onSelect }: { templates: Template[]; credits: number; onSelect: (template: Template) => void }) {
  const [category, setCategory] = useState<VideoCategory>("热门");
  const [bannerIndex, setBannerIndex] = useState(0);
  const [bannerRef, bannerApi] = useEmblaCarousel({ loop: true, skipSnaps: false, dragFree: false });
  const list = useMemo(() => templatesForCategory(category, templates), [category, templates]);

  useEffect(() => {
    if (!bannerApi) return;
    const updateSelected = () => setBannerIndex(bannerApi.selectedScrollSnap());
    updateSelected();
    bannerApi.on("select", updateSelected);
    const timer = window.setInterval(() => {
      bannerApi.scrollNext();
    }, 4600);
    return () => {
      window.clearInterval(timer);
      bannerApi.off("select", updateSelected);
    };
  }, [bannerApi]);

  return (
    <div className="h-full overflow-y-auto pb-28 scrollbar-none" style={{ color: "var(--ly-text)", background: "var(--ly-background)" }}>
      <header className="flex items-center justify-between gap-4 px-5 pb-4 pt-[max(24px,env(safe-area-inset-top))] sm:pt-4">
        <h1 className="text-[29px] font-bold text-[var(--ly-accent)]">视频玩法</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="flex h-11 w-11 items-center justify-center rounded-full opacity-85" aria-label="最近使用">
            <Clock3 size={24} />
          </button>
          <button type="button" className="flex h-10 items-center gap-1.5 rounded-[8px] px-3 text-xs font-semibold" style={{ color: "var(--ly-text)", background: "var(--ly-surface)" }} aria-label={`剩余 ${credits} 次制作机会`}>
            <Gift size={15} className="text-[var(--ly-accent)]" /> {credits} 次
          </button>
        </div>
      </header>

      <main>
        <div className="relative mx-5">
          <section ref={bannerRef} className="aspect-[16/7] overflow-hidden rounded-[8px] bg-[#17171a] ring-1 ring-white/[.1]" aria-roledescription="轮播图" aria-label={`视频玩法横幅，第 ${bannerIndex + 1} 张，共 ${BANNERS.length} 张`}>
            <div className="flex h-full touch-pan-y">
              {BANNERS.map((item) => {
                const template = templates.find((candidate) => candidate.id === item.templateId) || templates[0];
                return (
                  <button key={item.id} type="button" onClick={() => template && onSelect(template)} className="relative h-full min-w-0 flex-[0_0_100%] text-left text-white" aria-label={`${item.title}，查看详情`}>
                    <img src={item.image} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    <span className="banner-scrim absolute inset-0" />
                    <span className="absolute inset-y-0 left-0 flex w-[64%] flex-col justify-center px-4">
                      <span className="text-[11px] font-semibold text-[#72f5d1]">{item.kicker}</span>
                      <span className="mt-1.5 text-[19px] font-semibold leading-snug">{item.title}</span>
                      <span className="mt-3 flex min-h-[36px] w-fit items-center gap-1 rounded-[8px] px-3 text-[12px] font-semibold text-white" style={{ backgroundColor: "var(--ly-accent)" }}>
                        {item.action}<ChevronRight size={14} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
          <div className="absolute bottom-2 right-3 flex gap-1.5" role="tablist" aria-label="横幅切换">
            {BANNERS.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-label={`查看${item.kicker}`}
                aria-selected={index === bannerIndex}
                onClick={() => bannerApi?.scrollTo(index)}
                className={`h-1.5 min-h-0 rounded-full transition-all ${index === bannerIndex ? "w-5 bg-white" : "w-1.5 bg-white/45"}`}
              />
            ))}
          </div>
        </div>

        <section className="mt-5" aria-label="视频分类">
          <div className="overflow-x-auto px-5 pb-1 scrollbar-none">
            <div className="inline-flex min-w-max gap-7" role="tablist" aria-label="视频分类">
              {VIDEO_CATEGORIES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={category === item}
                  onClick={() => setCategory(item)}
                  className={`video-category-tab relative min-h-[42px] shrink-0 px-0 text-[15px] font-medium transition-colors ${category === item ? "opacity-100" : "opacity-50"}`}
                >
                  {item}
                  {category === item && <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-8 rounded-full bg-[var(--ly-secondary)]" />}
                </button>
              ))}
            </div>
          </div>

          {list.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-5 px-5" aria-live="polite">
              {list.map((template) => <VideoCard key={template.id} template={template} onSelect={onSelect} />)}
            </div>
          ) : (
            <div className="mx-5 mt-4 flex min-h-[152px] items-center justify-center rounded-[8px] border border-dashed border-white/[.16] px-6 text-center text-sm text-white/55">
              这个分类正在准备中
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
