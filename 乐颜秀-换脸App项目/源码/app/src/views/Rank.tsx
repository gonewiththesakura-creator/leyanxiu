import { useState } from "react";
import { ChevronRight, Trophy } from "lucide-react";
import type { Template } from "@/data/templates";
import { TemplateVideoPreview } from "@/views/TemplateMedia";

const RANK_CATEGORIES = ["编辑推荐", "经典精选", "最近上新"] as const;
type RankCategory = typeof RANK_CATEGORIES[number];

function templatesForRank(category: RankCategory, templates: Template[]) {
  if (category === "编辑推荐") return templates;
  if (category === "经典精选") {
    return templates.filter((template) => template.name.includes("经典") || template.description.includes("经典"));
  }
  return templates;
}

function RankCard({ template, index, onSelect }: { template: Template; index: number; onSelect: (template: Template) => void }) {
  return (
    <button type="button" onClick={() => onSelect(template)} className="rank-card soft-press flex min-h-[132px] w-full gap-3 rounded-[8px] border border-white/[.08] p-3 text-left shadow-[0_10px_26px_rgba(0,0,0,.28)]" style={{ color: "var(--ly-text)", background: "var(--ly-surface)" }}>
      <div className="relative w-[92px] shrink-0 overflow-hidden rounded-[8px] bg-[#242429]">
        <TemplateVideoPreview template={template} />
        <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-md">推荐 {index + 1}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="mt-1 truncate text-[18px] font-semibold">{template.name}</h3>
        <p className="mt-2 text-sm font-medium opacity-50">{template.category} · {template.duration}</p>
        <div className="mt-auto flex justify-end pt-3">
          <span className="flex min-h-[40px] shrink-0 items-center gap-1 rounded-[8px] px-3 text-[13px] font-semibold text-white" style={{ backgroundColor: "var(--ly-accent)" }}>
            做同款
            <ChevronRight size={15} />
          </span>
        </div>
      </div>
    </button>
  );
}

export function RankView({ templates, onSelect }: { templates: Template[]; onSelect: (template: Template) => void }) {
  const [category, setCategory] = useState<RankCategory>("编辑推荐");
  const list = templatesForRank(category, templates);
  const listTitle = category;

  return (
    <div className="h-full overflow-y-auto pb-28 scrollbar-none" style={{ color: "var(--ly-text)", background: "var(--ly-background)" }}>
      <header className="px-5 pb-4 pt-[max(24px,env(safe-area-inset-top))] sm:pt-4">
        <h1 className="text-[30px] font-bold text-[var(--ly-accent)]">模板推荐</h1>
      </header>

      <main>
        <section className="px-5" aria-labelledby="rank-category-title">
          <div className="flex items-end justify-between gap-3">
            <h2 id="rank-category-title" className="sr-only">选择榜单</h2>
          </div>
          <div className="grid grid-cols-3 border-b border-white/[.08]" role="tablist" aria-label="榜单分类">
            {RANK_CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={category === item}
                onClick={() => setCategory(item)}
                className={`relative min-h-[46px] px-2 text-[14px] font-medium transition ${category === item ? "opacity-100" : "opacity-45"}`}
              >
                {item}
                {category === item && <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-8 rounded-full bg-[var(--ly-secondary)]" />}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6" aria-labelledby="rank-list-title">
          <div className="flex items-end justify-between px-5">
            <div>
              <p className="text-[13px] font-medium text-[var(--ly-secondary)]">{category}</p>
              <h2 id="rank-list-title" className="mt-1 text-[22px] font-semibold">{listTitle}</h2>
            </div>
          </div>

          {list.length > 0 ? (
            <div className="mt-4 grid gap-3 px-5" aria-live="polite">
              {list.map((template, index) => <RankCard key={template.id} template={template} index={index} onSelect={onSelect} />)}
            </div>
          ) : (
            <div className="mx-5 mt-4 flex min-h-[170px] flex-col items-center justify-center rounded-[8px] border border-dashed border-white/[.14] px-6 text-center">
              <Trophy size={26} className="text-white/45" strokeWidth={1.8} />
              <p className="mt-3 text-base font-semibold text-white">暂无内容</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
