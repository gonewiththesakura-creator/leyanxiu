import { useEffect, useMemo, useState } from "react";
import { Brush, ChevronRight, Clock3, ImagePlus, Landmark, MessageSquareText, ScanFace } from "lucide-react";
import { PHOTO_EFFECT_CATEGORIES, PHOTO_EFFECTS, photoEffectToTemplate, type PhotoEffect, type PhotoEffectCategory, type PhotoEffectCategoryId } from "@/data/effects";
import type { Template } from "@/data/templates";
import { getCapabilities, LOCAL_DEMO_MODE } from "@/lib/api";
import { APP_ACCOUNT_ONLY } from '@/lib/account-only';

const CATEGORY_ICONS = {
  time: Clock3,
  culture: Landmark,
  art: Brush,
  restore: ScanFace,
};

export function CustomView({
  categories = PHOTO_EFFECT_CATEGORIES,
  photoEffects = PHOTO_EFFECTS,
  onSelect,
  onCaption,
  captionEnabled = true,
  networkEnabled,
  focusCategoryId,
}: {
  categories?: PhotoEffectCategory[];
  photoEffects?: PhotoEffect[];
  onSelect: (template: Template) => void;
  onCaption: () => void;
  captionEnabled?: boolean;
  networkEnabled: boolean;
  focusCategoryId?: PhotoEffectCategoryId;
}) {
  const [categoryId, setCategoryId] = useState<PhotoEffectCategoryId>(focusCategoryId || categories[0]?.id || "time");
  const [readyCapabilities, setReadyCapabilities] = useState<Set<string> | null>(null);
  const selectedCategoryId = categories.some((item) => item.id === categoryId) ? categoryId : categories[0]?.id;
  const category = categories.find((item) => item.id === selectedCategoryId);
  const effects = useMemo(() => category ? photoEffects.filter((item) => item.categoryId === category.id) : [], [category, photoEffects]);
  const CategoryIcon = category && category.id in CATEGORY_ICONS ? CATEGORY_ICONS[category.id as keyof typeof CATEGORY_ICONS] : ImagePlus;

  useEffect(() => {
    if (!networkEnabled || LOCAL_DEMO_MODE) return;
    let active = true;
    void getCapabilities()
      .then((entries) => {
        if (active) setReadyCapabilities(new Set(entries.filter((entry) => entry.ready).map((entry) => entry.id)));
      })
      .catch(() => {
        if (active) setReadyCapabilities(new Set());
      });
    return () => {
      active = false;
    };
  }, [networkEnabled]);

  if (!category || !selectedCategoryId) {
    return (
      <div className="flex h-full items-center justify-center px-5 pb-28 text-center" style={{ color: "var(--ly-text)", background: "var(--ly-background)" }}>
        <div className="w-full rounded-[8px] border border-dashed border-current/20 p-6">
          <ImagePlus className="mx-auto opacity-50" size={26} />
          <p className="mt-3 text-base font-semibold">暂无图片分区</p>
          <p className="mt-1 text-sm opacity-55">请先在后台启用至少一个图片分类</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pb-28 scrollbar-none" style={{ color: "var(--ly-text)", background: "var(--ly-background)" }}>
      <header className="px-5 pb-4 pt-[max(24px,env(safe-area-inset-top))] sm:pt-4">
        <h1 className="text-[30px] font-bold leading-tight text-[var(--ly-accent)]">百变图片</h1>
        <p className="mt-2 text-sm opacity-55">一张照片，随心变化</p>
      </header>

      <main>
        <section aria-labelledby="effect-categories-title">
          <h2 id="effect-categories-title" className="sr-only">照片效果分类</h2>
          <div className="overflow-x-auto px-5 pb-2 scrollbar-none">
            <div className="flex w-max gap-3" role="tablist" aria-label="照片效果分类">
              {categories.map((item) => {
                const selected = item.id === selectedCategoryId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setCategoryId(item.id)}
                    className="effect-category relative h-[188px] w-[142px] shrink-0 overflow-hidden rounded-[8px] bg-[#d8d5d1] text-left shadow-[0_12px_26px_rgba(34,28,24,.1)]"
                    style={{ boxShadow: selected ? `0 14px 30px ${item.accent}33` : undefined }}
                  >
                    <img src={item.cover} alt="" className="absolute inset-0 h-full w-full object-cover" />
                    <span className="effect-category-scrim absolute inset-0" />
                    <span className="absolute inset-x-3 bottom-3 text-white">
                      <span className="block text-[10px] font-medium text-white/70">{item.kicker}</span>
                      <span className="mt-0.5 block text-[17px] font-semibold">{item.name}</span>
                    </span>
                    {selected && <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ backgroundColor: item.accent }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className="mt-5" aria-labelledby="effect-list-title">
          <div className="flex items-start justify-between gap-3 px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2" style={{ color: category.accent }}>
                <CategoryIcon size={18} strokeWidth={1.9} />
                <p className="text-[13px] font-semibold">{category.kicker}</p>
              </div>
              <h2 id="effect-list-title" className="mt-1 text-[22px] font-semibold text-white">{category.name}</h2>
              <p className="mt-1 max-w-[280px] text-xs leading-relaxed text-white/50">{category.description}</p>
            </div>
            <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-[#1b1b1e] ring-1 ring-white/[.08]" style={{ color: category.accent }}>
              <ImagePlus size={20} />
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 px-5">
            {effects.map((effect, index) => {
              const template = photoEffectToTemplate(effect, categories);
              const capabilityId = template.mode === "photo-age" ? "photo-age" : "photo-effects";
              const checking = networkEnabled && !LOCAL_DEMO_MODE && readyCapabilities === null;
              const unavailable = APP_ACCOUNT_ONLY || (networkEnabled && !LOCAL_DEMO_MODE && !readyCapabilities?.has(capabilityId));
              return (
                <button
                  key={effect.id}
                  type="button"
                  disabled={unavailable}
                  onClick={() => onSelect(template)}
                  className="effect-option group soft-press relative min-h-[218px] overflow-hidden rounded-[8px] border border-white/[.08] text-left shadow-[0_8px_20px_rgba(0,0,0,.25)] disabled:cursor-not-allowed disabled:opacity-55"
                  style={{ animationDelay: `${Math.min(index * 30, 240)}ms`, color: "var(--ly-text)", background: "var(--ly-surface)" }}
                >
                <span className="relative block aspect-[4/3] overflow-hidden bg-[#26262b]">
                  <img src={effect.preview} alt={`${effect.title}效果预览`} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]" />
                  <span className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
                  {effect.badge && <span className="absolute right-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[9px] font-semibold text-white backdrop-blur-md">{effect.badge}</span>}
                  {unavailable && <span className="absolute inset-x-2 bottom-2 rounded-[6px] bg-black/70 px-2 py-1.5 text-center text-[10px] font-semibold text-white backdrop-blur-md">{checking ? "正在核验" : "暂未开放"}</span>}
                </span>
                <span className="block px-3 pb-3 pt-2.5">
                  <span className="block pr-4 text-[15px] font-semibold leading-snug">{effect.title}</span>
                  <span className="mt-1 line-clamp-2 block text-[11px] leading-[1.45] opacity-45">{effect.subtitle}</span>
                </span>
                <ChevronRight size={15} className="absolute bottom-3 right-3 text-white/35" />
                </button>
              );
            })}
          </div>
        </section>

        {captionEnabled && (
          <section className="mx-5 mt-6 border-t border-white/[.08] pt-5" aria-label="分享文案">
            <button
              type="button"
              onClick={onCaption}
              className="soft-press flex min-h-[78px] w-full items-center gap-3 rounded-[8px] px-4 text-left shadow-[0_12px_28px_rgba(0,0,0,.3)] ring-1 ring-white/[.08]"
              style={{ color: "var(--ly-text)", background: "var(--ly-surface)" }}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] bg-white/10">
                <MessageSquareText size={22} />
              </span>
              <span className="min-w-0">
                <span className="block text-[16px] font-semibold">成片分享文案</span>
                <span className="mt-1 block truncate text-xs text-white/65">做好作品后，配一句自然的话</span>
              </span>
              <ChevronRight size={19} className="ml-auto shrink-0 text-white/60" />
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
