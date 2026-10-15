import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  CookingPot,
  Gift,
  HeartPulse,
  Lightbulb,
  LoaderCircle,
  Map,
  MessageCircle,
  MessagesSquare,
  Moon,
  RotateCcw,
  Scroll,
  Sparkles,
  Tags,
} from "lucide-react";
import { analyzePlay, type PlayAnalysis } from "@/lib/api";

interface PlayItem {
  id: string;
  title: string;
  subtitle: string;
  placeholder: string;
  inputLabel: string;
  cover?: string;
  icon?: LucideIcon;
  nameField?: boolean;
  birthField?: boolean;
  timeField?: boolean;
  todayField?: boolean;
  singleCharacter?: boolean;
}

const FEATURED_PLAYS: PlayItem[] = [
  {
    id: "future_wife",
    title: "测未来老婆名字",
    subtitle: "解锁你的缘分名字彩蛋",
    cover: "/plays/future-wife.png",
    nameField: true,
    birthField: true,
    inputLabel: "期待的缘分",
    placeholder: "比如：喜欢爱笑、真诚、热爱生活的人",
  },
  {
    id: "wealth",
    title: "测财运",
    subtitle: "看看今天的财富关键词",
    cover: "/plays/wealth.png",
    nameField: true,
    birthField: true,
    inputLabel: "最近关心的事",
    placeholder: "比如：想存下一笔旅行基金",
  },
  {
    id: "wuxing",
    title: "算五行",
    subtitle: "历法计算八字与五行",
    cover: "/plays/wuxing.png",
    nameField: true,
    birthField: true,
    timeField: true,
    inputLabel: "想了解的方向",
    placeholder: "比如：性格、家庭或生活配色",
  },
  {
    id: "daily_fortune",
    title: "今日运势",
    subtitle: "今日宜忌与生活提示",
    cover: "/plays/daily-fortune.png",
    nameField: true,
    todayField: true,
    inputLabel: "今天最关心什么",
    placeholder: "比如：工作沟通、家庭聚会",
  },
  {
    id: "character_fortune",
    title: "测字",
    subtitle: "从一个汉字读出心境",
    cover: "/plays/character.png",
    inputLabel: "写下一个汉字",
    placeholder: "例如：安",
    singleCharacter: true,
  },
];

const TEXT_PLAYS: PlayItem[] = [
  { id: "blessing", title: "祝福语", subtitle: "节日寿宴吉祥话", icon: Gift, inputLabel: "场合与对象", placeholder: "比如：姐姐六十大寿" },
  { id: "moments", title: "朋友圈文案", subtitle: "照片配文更出彩", icon: MessageCircle, inputLabel: "照片或心情", placeholder: "比如：今天和老姐妹游西湖" },
  { id: "health", title: "养生顾问", subtitle: "饮食运动小建议", icon: HeartPulse, inputLabel: "想问的问题", placeholder: "比如：晚上睡不好怎么办" },
  { id: "recipe", title: "家常菜谱", subtitle: "报菜名就教你做", icon: CookingPot, inputLabel: "菜名或现有食材", placeholder: "比如：土豆、鸡蛋和青椒" },
  { id: "travel", title: "旅游规划", subtitle: "轻松不累的行程", icon: Map, inputLabel: "目的地与天数", placeholder: "比如：杭州三日游，两位老人" },
  { id: "naming", title: "起名大师", subtitle: "人名店名群名", icon: Tags, inputLabel: "起名需求", placeholder: "比如：给孙女起名，姓李" },
  { id: "couplet", title: "对联创作", subtitle: "春联寿联乔迁联", icon: Scroll, inputLabel: "对联场合", placeholder: "比如：新店开业" },
  { id: "dream", title: "解梦", subtitle: "民俗与心理联想", icon: Moon, inputLabel: "梦境内容", placeholder: "比如：梦见回到小时候的老房子" },
  { id: "poem", title: "诗词园地", subtitle: "赏诗也能写新诗", icon: BookOpen, inputLabel: "诗词主题", placeholder: "比如：写一首秋游小诗" },
  { id: "life", title: "生活妙招", subtitle: "清洁收纳省心窍门", icon: Lightbulb, inputLabel: "生活难题", placeholder: "比如：白衣服发黄怎么洗" },
  { id: "chat", title: "贴心陪聊", subtitle: "随时说说心里话", icon: MessagesSquare, inputLabel: "想聊的话题", placeholder: "比如：今天心情不错" },
];

function todayText() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function PlayDetail({ item, onBack }: { item: PlayItem; onBack: () => void }) {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [birthTime, setBirthTime] = useState("12:00");
  const [date, setDate] = useState(todayText());
  const [input, setInput] = useState("");
  const [result, setResult] = useState<PlayAnalysis | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => {
    if (item.birthField && !birthDate) return false;
    if (item.todayField && !date) return false;
    if (item.singleCharacter) return /^\p{Script=Han}$/u.test(input.trim());
    return Boolean(input.trim() || name.trim() || item.birthField || item.todayField);
  }, [birthDate, date, input, item, name]);

  const submit = async () => {
    if (!canSubmit || loading) return;
    setError("");
    setLoading(true);
    try {
      const analysis = await analyzePlay({
        scene: item.id,
        input: input.trim(),
        profile: {
          name: name.trim() || undefined,
          birthDate: birthDate || undefined,
          birthTime: item.timeField ? birthTime : undefined,
          date: item.todayField ? date : undefined,
        },
      });
      setResult(analysis);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "玩法服务暂时不可用");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setResult(null);
    setError("");
  };

  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f7] pb-28">
      <header className="flex items-center gap-3 px-5 pb-4 pt-6 sm:pt-4">
        <button type="button" onClick={onBack} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/[.06]" aria-label="返回玩法列表">
          <ArrowLeft size={21} />
        </button>
        <div>
          <p className="text-xs font-medium text-[#0071e3]">AI 文字玩法</p>
          <h2 className="mt-0.5 text-[22px] font-semibold text-[#1d1d1f]">{item.title}</h2>
        </div>
      </header>

      {item.cover && (
        <div className="relative mx-5 aspect-[16/9] overflow-hidden rounded-[8px] bg-[#d8d8dc] shadow-[0_14px_34px_rgba(0,0,0,.10)]">
          <img src={item.cover} alt={item.title} className="h-full w-full object-cover" />
          <div className="image-scrim absolute inset-0" />
          <p className="absolute inset-x-0 bottom-0 p-4 text-sm font-medium text-white">{item.subtitle}</p>
        </div>
      )}

      <main className="px-5 pt-5">
        {result ? (
          <section className="rounded-[8px] border border-black/[.06] bg-white p-5 shadow-sm" aria-live="polite">
            <div className="flex items-center gap-2 text-[#0071e3]">
              <Sparkles size={19} />
              <h3 className="text-[18px] font-semibold">测试结果</h3>
            </div>

            {result.facts && item.id === "wuxing" && (
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[8px] bg-[#f5f5f7] p-3"><p className="text-xs text-[#86868b]">农历</p><p className="mt-1 font-medium">{String(result.facts.lunarDate || "-")}</p></div>
                <div className="rounded-[8px] bg-[#f5f5f7] p-3"><p className="text-xs text-[#86868b]">生肖</p><p className="mt-1 font-medium">{String(result.facts.zodiac || "-")}</p></div>
                <div className="col-span-2 rounded-[8px] bg-[#f5f5f7] p-3"><p className="text-xs text-[#86868b]">八字</p><p className="mt-1 font-medium">{Array.isArray(result.facts.bazi) ? result.facts.bazi.join(" · ") : "-"}</p></div>
              </div>
            )}

            {result.facts && item.id === "daily_fortune" && (
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-[8px] bg-[#f1fbf3] p-3 text-[#248a3d]"><p className="text-xs">今日宜</p><p className="mt-1 font-medium">{Array.isArray(result.facts.yi) ? result.facts.yi.slice(0, 3).join("、") : "随心"}</p></div>
                <div className="rounded-[8px] bg-[#fff5f4] p-3 text-[#c9342d]"><p className="text-xs">今日忌</p><p className="mt-1 font-medium">{Array.isArray(result.facts.ji) ? result.facts.ji.slice(0, 3).join("、") : "焦虑"}</p></div>
              </div>
            )}

            <div className="mt-5 text-[15px] leading-7 text-[#3a3a3c]">
              <ReactMarkdown
                components={{
                  h1: ({ children }) => <h4 className="mb-2 mt-5 text-lg font-semibold text-[#1d1d1f]">{children}</h4>,
                  h2: ({ children }) => <h4 className="mb-2 mt-5 text-lg font-semibold text-[#1d1d1f]">{children}</h4>,
                  h3: ({ children }) => <h4 className="mb-2 mt-5 text-base font-semibold text-[#1d1d1f]">{children}</h4>,
                  p: ({ children }) => <p className="my-2.5">{children}</p>,
                  ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5">{children}</ul>,
                  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1 pl-5">{children}</ol>,
                  strong: ({ children }) => <strong className="font-semibold text-[#1d1d1f]">{children}</strong>,
                  hr: () => <hr className="my-4 border-black/[.08]" />,
                }}
              >
                {result.reply}
              </ReactMarkdown>
            </div>
            <div className="mt-5 flex items-center justify-between border-t border-black/[.06] pt-4 text-xs text-[#86868b]">
              <span>由 {result.provider === "deepseek" ? "DeepSeek" : "混元"} 生成</span>
              <span>仅供娱乐参考</span>
            </div>
            <button type="button" onClick={reset} className="mt-4 flex w-full items-center justify-center gap-2 rounded-[8px] border border-black/[.08] bg-white py-3 text-base font-medium shadow-sm">
              <RotateCcw size={17} /> 再测一次
            </button>
          </section>
        ) : (
          <section className="rounded-[8px] border border-black/[.06] bg-white p-5 shadow-sm">
            {item.nameField && (
              <label className="block">
                <span className="text-sm font-medium text-[#1d1d1f]">你的称呼</span>
                <input value={name} onChange={(event) => setName(event.target.value)} maxLength={30} placeholder="怎么称呼你" className="mt-2 h-12 w-full rounded-[8px] border border-black/[.10] bg-[#f9f9fb] px-3.5 text-base outline-none focus:border-[#0071e3]" />
              </label>
            )}

            <div className={`grid gap-3 ${item.birthField && item.timeField ? "mt-4 grid-cols-[1fr_108px]" : ""}`}>
              {item.birthField && (
                <label className="block">
                  <span className="text-sm font-medium text-[#1d1d1f]">出生日期</span>
                  <input type="date" value={birthDate} max={todayText()} onChange={(event) => setBirthDate(event.target.value)} className="mt-2 h-12 w-full rounded-[8px] border border-black/[.10] bg-[#f9f9fb] px-3 text-sm outline-none focus:border-[#0071e3]" />
                </label>
              )}
              {item.timeField && (
                <label className="block">
                  <span className="text-sm font-medium text-[#1d1d1f]">时间</span>
                  <input type="time" value={birthTime} onChange={(event) => setBirthTime(event.target.value)} className="mt-2 h-12 w-full rounded-[8px] border border-black/[.10] bg-[#f9f9fb] px-3 text-sm outline-none focus:border-[#0071e3]" />
                </label>
              )}
            </div>

            {item.todayField && (
              <label className={`block ${item.nameField ? "mt-4" : ""}`}>
                <span className="text-sm font-medium text-[#1d1d1f]">查看日期</span>
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 h-12 w-full rounded-[8px] border border-black/[.10] bg-[#f9f9fb] px-3.5 text-base outline-none focus:border-[#0071e3]" />
              </label>
            )}

            <label className={`block ${item.nameField || item.birthField || item.todayField ? "mt-4" : ""}`}>
              <span className="text-sm font-medium text-[#1d1d1f]">{item.inputLabel}</span>
              {item.singleCharacter ? (
                <input value={input} onChange={(event) => setInput(event.target.value.slice(0, 1))} maxLength={1} placeholder={item.placeholder} className="mt-2 h-16 w-full rounded-[8px] border border-black/[.10] bg-[#f9f9fb] px-4 text-center text-[30px] outline-none focus:border-[#0071e3]" />
              ) : (
                <textarea value={input} onChange={(event) => setInput(event.target.value)} maxLength={1200} rows={4} placeholder={item.placeholder} className="mt-2 w-full resize-none rounded-[8px] border border-black/[.10] bg-[#f9f9fb] p-3.5 text-base leading-relaxed outline-none focus:border-[#0071e3]" />
              )}
            </label>

            {error && <p className="mt-3 rounded-[8px] bg-[#fff2f1] px-3 py-2 text-sm text-[#c9342d]">{error}</p>}
            <button type="button" disabled={!canSubmit || loading} onClick={submit} className="mt-5 flex w-full items-center justify-center gap-2 rounded-[8px] bg-[#0071e3] py-3.5 text-[17px] font-semibold text-white shadow-[0_8px_18px_rgba(0,113,227,.22)] disabled:bg-[#d2d2d7] disabled:shadow-none">
              {loading ? <><LoaderCircle size={19} className="animate-spin" /> 正在分析</> : <><Sparkles size={19} /> 开始测试</>}
            </button>
            <p className="mt-3 text-center text-xs text-[#86868b]">民俗文化与 AI 文字娱乐，不作为现实决策依据</p>
          </section>
        )}
      </main>
    </div>
  );
}

export function PlayView() {
  const [selected, setSelected] = useState<PlayItem | null>(null);

  if (selected) return <PlayDetail item={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f7] pb-28">
      <header className="px-5 pb-4 pt-7 sm:pt-4">
        <p className="text-[13px] font-medium text-[#0071e3]">AI 文字乐园</p>
        <h1 className="mt-1 text-[28px] font-semibold text-[#1d1d1f]">有趣的玩法</h1>
        <p className="mt-1 text-sm text-[#6e6e73]">测一测，写一写，给生活添点灵感</p>
      </header>

      <main>
        <section aria-labelledby="fun-tests-title">
          <div className="flex items-end justify-between px-5">
            <h2 id="fun-tests-title" className="text-[20px] font-semibold text-[#1d1d1f]">热门测算</h2>
            <span className="text-xs text-[#86868b]">仅供娱乐</span>
          </div>
          <div className="scrollbar-none mt-3 flex snap-x gap-3 overflow-x-auto px-5 pb-3">
            {FEATURED_PLAYS.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelected(item)} className="group relative aspect-[3/4] w-[168px] shrink-0 snap-start overflow-hidden rounded-[8px] bg-[#d8d8dc] text-left shadow-[0_10px_26px_rgba(0,0,0,.10)] active:scale-[.98]">
                <img src={item.cover} alt={item.title} className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                <div className="card-scrim absolute inset-0" />
                <div className="absolute inset-x-0 bottom-0 p-3.5 text-white">
                  <p className="text-[17px] font-semibold">{item.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-white/75">{item.subtitle}</p>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6 px-5" aria-labelledby="assistants-title">
          <div className="flex items-end justify-between">
            <h2 id="assistants-title" className="text-[20px] font-semibold text-[#1d1d1f]">生活文字助手</h2>
            <span className="text-xs text-[#86868b]">DeepSeek</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {TEXT_PLAYS.map((item) => {
              const Icon = item.icon || Sparkles;
              return (
                <button key={item.id} type="button" onClick={() => setSelected(item)} className="min-h-[122px] rounded-[8px] border border-black/[.06] bg-white p-4 text-left shadow-sm active:scale-[.98]">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#edf6ff] text-[#0071e3]"><Icon size={20} /></span>
                    <ChevronRight size={17} className="mt-1 text-[#aeaeb2]" />
                  </div>
                  <p className="mt-3 text-[15px] font-semibold text-[#1d1d1f]">{item.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-[#6e6e73]">{item.subtitle}</p>
                </button>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
