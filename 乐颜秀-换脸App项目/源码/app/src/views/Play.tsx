import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Check, Clipboard, LoaderCircle, RefreshCw, Send, Sparkles } from "lucide-react";
import { analyzePlay, type PlayAnalysis } from "@/lib/api";

const WORK_TYPES = ["唱歌视频", "舞蹈视频", "写真照片", "老照片", "全家福"];
const TONES = ["温暖自然", "开心热闹", "怀旧走心", "简单大方"];

export function PlayView({ onBack }: { onBack?: () => void }) {
  const [workType, setWorkType] = useState(WORK_TYPES[0]);
  const [tone, setTone] = useState(TONES[0]);
  const [detail, setDetail] = useState("");
  const [result, setResult] = useState<PlayAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!detail.trim() || loading) return;
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const analysis = await analyzePlay({
        scene: "share_caption",
        input: `作品类型：${workType}\n文案感觉：${tone}\n作品内容：${detail.trim()}`,
      });
      setResult(analysis);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "文案服务暂时不可用");
    } finally {
      setLoading(false);
    }
  };

  const copyResult = async () => {
    if (!result?.reply) return;
    await navigator.clipboard.writeText(result.reply.replace(/[*#>-]/g, "").trim());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const reset = () => {
    setResult(null);
    setError("");
    setCopied(false);
  };

  return (
    <div className="h-full overflow-y-auto bg-[#f5f5f7] pb-28">
      <header className="px-5 pb-5 pt-7 sm:pt-4">
        <div className="flex items-start gap-3">
          {onBack && (
            <button type="button" onClick={onBack} className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-[#1d1d1f] shadow-sm ring-1 ring-black/[.06]" aria-label="返回自定义">
              <ArrowLeft size={20} />
            </button>
          )}
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[#0071e3]">AI 分享助手</p>
            <h1 className="mt-1 text-[28px] font-semibold text-[#1d1d1f]">给作品配句话</h1>
            <p className="mt-1 text-sm text-[#6e6e73]">做完视频和照片，直接生成分享文案</p>
          </div>
        </div>
      </header>

      <main className="px-5">
        <div className="caption-hero relative aspect-[16/9] overflow-hidden rounded-[8px] bg-[#d8d8dc] shadow-[0_16px_36px_rgba(0,0,0,.12)]">
          <img src="/plays/overview-openai.png" alt="分享文案创作静物" className="h-full w-full object-cover object-[center_72%]" />
          <div className="image-scrim absolute inset-0" />
          <div className="absolute inset-x-0 bottom-0 p-4 text-white">
            <div className="flex items-center gap-2"><Sparkles size={17} /><p className="text-[17px] font-semibold">让好作品更好分享</p></div>
          </div>
        </div>

        {result ? (
          <section className="result-reveal mt-5 rounded-[8px] border border-black/[.06] bg-white p-5 shadow-sm" aria-live="polite">
            <div className="flex items-center gap-3">
              <div><p className="text-xs font-medium text-[#0071e3]">{workType} · {tone}</p><h2 className="mt-1 text-[20px] font-semibold text-[#1d1d1f]">分享文案</h2></div>
            </div>

            <div className="mt-4 text-[15px] leading-7 text-[#3a3a3c]">
              <ReactMarkdown components={{
                h1: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-[#1d1d1f]">{children}</h3>,
                h2: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-[#1d1d1f]">{children}</h3>,
                h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-[#1d1d1f]">{children}</h3>,
                p: ({ children }) => <p className="my-2.5">{children}</p>,
                ul: ({ children }) => <ul className="my-2.5 list-disc space-y-1 pl-5">{children}</ul>,
                ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-2 pl-5">{children}</ol>,
                strong: ({ children }) => <strong className="font-semibold text-[#1d1d1f]">{children}</strong>,
                hr: () => <hr className="my-4 border-black/[.08]" />,
              }}>{result.reply}</ReactMarkdown>
            </div>

            <button type="button" onClick={copyResult} className={`soft-press mt-5 flex w-full items-center justify-center gap-2 rounded-[8px] py-3.5 text-[16px] font-semibold text-white ${copied ? "bg-[#248a3d]" : "bg-[#0071e3] shadow-[0_8px_18px_rgba(0,113,227,.22)]"}`}>
              {copied ? <><Check size={19} /> 已复制</> : <><Clipboard size={19} /> 复制全部文案</>}
            </button>
            <button type="button" onClick={reset} className="mt-2 flex w-full items-center justify-center gap-2 py-2.5 text-sm font-medium text-[#6e6e73]"><RefreshCw size={15} /> 换个内容</button>
          </section>
        ) : (
          <section className="mt-5 rounded-[8px] border border-black/[.06] bg-white p-5 shadow-sm">
            <fieldset>
              <legend className="text-sm font-semibold text-[#1d1d1f]">这是什么作品？</legend>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {WORK_TYPES.map((item) => <button type="button" key={item} onClick={() => setWorkType(item)} className={`h-10 min-w-0 rounded-[8px] px-2 text-[13px] font-medium transition-all ${workType === item ? "bg-[#1d1d1f] text-white shadow-sm" : "bg-[#f5f5f7] text-[#6e6e73]"}`}>{item}</button>)}
              </div>
            </fieldset>

            <fieldset className="mt-5">
              <legend className="text-sm font-semibold text-[#1d1d1f]">想要什么感觉？</legend>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {TONES.map((item) => <button type="button" key={item} onClick={() => setTone(item)} className={`h-11 rounded-[8px] border text-sm font-medium transition-all ${tone === item ? "border-[#0071e3] bg-[#edf6ff] text-[#0055a8]" : "border-black/[.06] bg-[#f9f9fb] text-[#6e6e73]"}`}>{item}</button>)}
              </div>
            </fieldset>

            <label className="mt-5 block">
              <span className="text-sm font-semibold text-[#1d1d1f]">作品里有什么？</span>
              <textarea value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={500} rows={4} placeholder="比如：和老姐妹在西湖边跳了一支舞，大家都很开心" className="mt-2 w-full resize-none rounded-[8px] border border-black/[.10] bg-[#f9f9fb] p-3.5 text-base leading-relaxed outline-none transition focus:border-[#0071e3] focus:bg-white" />
            </label>

            {error && <p className="mt-3 rounded-[8px] bg-[#fff2f1] px-3 py-2 text-sm text-[#c9342d]">{error}</p>}
            <button type="button" disabled={!detail.trim() || loading} onClick={submit} className="soft-press mt-5 flex w-full items-center justify-center gap-2 rounded-[8px] bg-[#0071e3] py-3.5 text-[17px] font-semibold text-white shadow-[0_8px_18px_rgba(0,113,227,.22)] disabled:bg-[#d2d2d7] disabled:shadow-none">
              {loading ? <><LoaderCircle size={19} className="animate-spin" /> 正在写文案</> : <><Send size={18} /> 生成分享文案</>}
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
