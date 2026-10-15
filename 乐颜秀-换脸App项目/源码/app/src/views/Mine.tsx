import { useCallback, useEffect, useState } from "react";
import { loadWorks, removeWork, type Work } from "@/data/templates";
import { deleteServerAccount, deleteServerAsset, getPublicCompliance, listServerWorks, LOCAL_DEMO_MODE, submitSafetyReport, withdrawFaceConsent, type PublicCompliance, type SafetyReportCategory } from "@/lib/api";
import { ChevronRight, ExternalLink, ImageOff, MessageSquareWarning, Settings, ShieldCheck, ShieldOff, Sparkles, Trash2, UserX, X } from "lucide-react";
import { clearPrivacyAcceptance } from "@/lib/privacy";
import { AccountCenter } from '@/components/AccountLogin';
import { APP_ACCOUNT_ONLY, ACCOUNT_ONLY_NOTICE } from '@/lib/account-only';

function useAccountWorks(networkEnabled: boolean) {
  const [works, setWorks] = useState<Work[]>(() => networkEnabled && LOCAL_DEMO_MODE ? loadWorks() : []);
  const [loading, setLoading] = useState(networkEnabled && !LOCAL_DEMO_MODE);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!networkEnabled) {
      setWorks([]);
      setLoading(false);
      setError("");
      return;
    }
    if (LOCAL_DEMO_MODE) {
      setWorks(loadWorks());
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setWorks(await listServerWorks());
      setError("");
    } catch (cause) {
      setWorks([]);
      setError(cause instanceof Error ? cause.message : "作品加载失败");
    } finally {
      setLoading(false);
    }
  }, [networkEnabled]);

  useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (id: string) => {
    if (LOCAL_DEMO_MODE) removeWork(id);
    else await deleteServerAsset(id);
    setWorks((current) => current.filter((work) => work.id !== id));
  };

  return { works, setWorks, loading, error, refresh, remove };
}

export function MineView({
  credits,
  onMake,
  onWorks,
  onRefill,
  privacyAccepted,
  onRequestPrivacy,
  onPrivacyReset,
}: {
  credits: number;
  onMake: () => void;
  onWorks: () => void;
  onRefill: () => void;
  privacyAccepted: boolean;
  onRequestPrivacy: () => void;
  onPrivacyReset: () => void;
}) {
  const { works, setWorks, loading, error, refresh } = useAccountWorks(privacyAccepted && !APP_ACCOUNT_ONLY);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [compliance, setCompliance] = useState<PublicCompliance | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState<SafetyReportCategory>("likeness");
  const [reportDescription, setReportDescription] = useState("");
  const [reportContact, setReportContact] = useState("");
  const [reportMessage, setReportMessage] = useState("");

  useEffect(() => {
    if (!privacyAccepted || !settingsOpen || compliance) return;
    void getPublicCompliance().then(setCompliance).catch(() => undefined);
  }, [privacyAccepted, settingsOpen, compliance]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handleNativeBack = (event: Event) => {
      event.preventDefault();
      if (!busy) setSettingsOpen(false);
    };
    document.addEventListener("leyanxiu:native-back", handleNativeBack);
    return () => document.removeEventListener("leyanxiu:native-back", handleNativeBack);
  }, [busy, settingsOpen]);

  const runPrivacyAction = async (action: "withdraw" | "account") => {
    const confirmed = window.confirm(APP_ACCOUNT_ONLY ? '注销后此账号将无法继续登录，手机号关联和登录会话将清除。必要安全记录按隐私政策保留。确认继续？' : action === "account"
      ? "注销后当前账号、作品和授权记录将进入删除流程，且无法恢复。确认继续？"
      : "撤回后将停止人脸处理，并删除当前账号下的相关影像。确认继续？");
    if (!confirmed) return;
    setBusy(true);
    setActionMessage("");
    try {
      const result = action === "account" ? await deleteServerAccount() : await withdrawFaceConsent();
      setWorks([]);
      setActionMessage(APP_ACCOUNT_ONLY ? '账号已注销，必要安全记录按隐私政策保留。' : result.partial ? "本地数据已删除，供应商副本删除仍在跟踪处理中。" : "操作已完成，相关数据已删除。");
      if (action === "withdraw") await refresh();
      else {
        clearPrivacyAcceptance();
        onPrivacyReset();
      }
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const sendReport = async () => {
    const description = reportDescription.trim();
    if (description.length < 20) {
      setActionMessage("请至少填写 20 个字，说明相关作品、模板和具体问题。");
      return;
    }
    setBusy(true);
    setActionMessage("");
    try {
      const { ticketId } = await submitSafetyReport({
        category: reportCategory,
        description,
        contact: reportContact.trim() || undefined,
      });
      setReportMessage(`已提交，工单号：${ticketId}`);
      setReportDescription("");
      setReportContact("");
    } catch (cause) {
      setActionMessage(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative h-full overflow-y-auto bg-black pb-28 text-white scrollbar-none">
      <header className="flex items-center justify-between px-5 pb-5 pt-[max(24px,env(safe-area-inset-top))] sm:pt-4">
        <h1 className="text-[30px] font-bold text-[#f23bd1]">我的</h1>
        <button type="button" onClick={() => setSettingsOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-full text-white" aria-label="设置">
          <Settings size={24} />
        </button>
      </header>

      <main className="px-5">
        {privacyAccepted && !LOCAL_DEMO_MODE && <AccountCenter/>}
        {APP_ACCOUNT_ONLY && <section className="rounded-lg border border-white/15 bg-[#17171a] p-4 text-sm leading-7 text-white/75">
          <p>{ACCOUNT_ONLY_NOTICE}</p>
          {!privacyAccepted && <button type="button" onClick={onRequestPrivacy} className="mt-3 min-h-12 w-full rounded-lg bg-violet-600 px-4 text-white">阅读协议并进入账号测试</button>}
          <p className="mt-3 break-all">客服与隐私联系邮箱：<a href="mailto:REDACTED_COMPANY_CONTACT_EMAIL" className="text-violet-300 underline">REDACTED_COMPANY_CONTACT_EMAIL</a></p>
        </section>}
        {!APP_ACCOUNT_ONLY && <>
        <button
          type="button"
          onClick={privacyAccepted ? onWorks : onRequestPrivacy}
          className="mine-vip-banner soft-press relative flex min-h-[128px] w-full overflow-hidden rounded-[8px] px-5 py-5 text-left text-white shadow-[0_16px_34px_rgba(85,57,180,.28)]"
        >
          <span className="relative z-10 min-w-0">
            <span className="block text-[25px] font-semibold">{privacyAccepted ? "我的创作" : "仅浏览模式"}</span>
            <span className="mt-2 block text-sm text-white/80">{privacyAccepted ? `剩余 ${credits} 次创作` : "未联网，也不会创建账号标识"}</span>
            <span className="mt-4 inline-flex items-center gap-1 text-[13px] font-semibold text-[#72f5d1]">{privacyAccepted ? "查看作品" : "阅读并开启创作"} <ChevronRight size={15} /></span>
          </span>
          {privacyAccepted ? <Sparkles size={78} strokeWidth={1.2} className="absolute right-3 top-6 text-white/60" /> : <ShieldCheck size={78} strokeWidth={1.2} className="absolute right-3 top-6 text-white/60" />}
        </button>

        {privacyAccepted && (
          <section className="mt-3 flex items-center justify-between gap-4 rounded-[8px] border border-white/[.1] bg-[#17171a] px-4 py-3.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">制作次数</p>
              <p className="mt-1 text-xs text-white/50">当前剩余 {credits} 次，以服务端台账为准</p>
            </div>
            <button type="button" onClick={onRefill} className="soft-press flex min-h-[42px] shrink-0 items-center gap-1.5 rounded-[8px] bg-white px-3 text-xs font-semibold text-[#1d1d1f]">
              <Sparkles size={15} /> 购买 / 订单
            </button>
          </section>
        )}

        <section className="mt-7" aria-labelledby="mine-works-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="mine-works-title" className="text-[20px] font-semibold">我的作品</h2>
            {works.length > 0 && (
              <button type="button" onClick={onWorks} className="flex min-h-[40px] items-center gap-0.5 text-xs text-white/55">全部 <ChevronRight size={15} /></button>
            )}
          </div>

          {!privacyAccepted ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
              <ShieldCheck size={52} strokeWidth={1.3} className="text-[#53535a]" />
              <p className="mt-5 text-[17px] text-white/78">未读取账号和作品</p>
              <p className="mt-2 max-w-[240px] text-xs leading-5 text-white/45">同意隐私政策后才会连接服务端</p>
              <button type="button" onClick={onRequestPrivacy} className="soft-press mt-6 min-w-[156px] rounded-[8px] bg-white px-6 py-3 text-[15px] font-semibold text-[#1d1d1f]">开启创作</button>
            </div>
          ) : loading ? (
            <div className="flex min-h-[260px] items-center justify-center text-sm text-white/55">正在读取账号作品…</div>
          ) : error ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
              <p className="text-sm text-white/65">{error}</p>
              <button type="button" onClick={() => void refresh()} className="mt-4 rounded-[8px] bg-white px-4 py-2 text-sm font-semibold text-black">重新加载</button>
            </div>
          ) : works.length === 0 ? (
            <div className="flex min-h-[380px] flex-col items-center justify-center text-center">
              <ImageOff size={56} strokeWidth={1.2} className="text-[#53535a]" />
              <p className="mt-5 text-[17px] text-white/78">还没有任何作品</p>
              <button type="button" onClick={onMake} className="soft-press mt-6 min-w-[156px] rounded-[8px] bg-[#3a3547] px-6 py-3 text-[15px] font-semibold text-[#f23bd1]">
                + 去制作
              </button>
            </div>
          ) : (
            <button type="button" onClick={onWorks} className="mt-4 grid w-full grid-cols-2 gap-3 text-left">
              {works.slice(0, 4).map((work) => (
                <span key={work.id} className="overflow-hidden rounded-[8px] bg-[#17171a] ring-1 ring-white/[.08]">
                  {work.kind === "video" ? <video src={work.image} className="aspect-[3/4] w-full object-cover" muted playsInline /> : <img src={work.image} alt="" className="aspect-[3/4] w-full object-cover" />}
                  <span className="block truncate px-3 py-2 text-sm">{work.templateName}</span>
                </span>
              ))}
            </button>
          )}
        </section>
        </>}
      </main>

      {settingsOpen && (
        <div className="absolute inset-0 z-40 flex items-end bg-black/65" role="dialog" aria-modal="true" aria-label="隐私与账号设置" onClick={() => !busy && setSettingsOpen(false)}>
          <div className="max-h-[88dvh] w-full overflow-y-auto rounded-t-[20px] bg-[#f5f5f7] p-5 pb-[max(24px,env(safe-area-inset-bottom))] text-[#1d1d1f]" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-[#6e6e73]">隐私与账号</p>
                <h2 className="mt-1 text-[22px] font-semibold">数据控制</h2>
              </div>
              <button type="button" disabled={busy} onClick={() => setSettingsOpen(false)} className="flex h-10 w-10 items-center justify-center rounded-full bg-white" aria-label="关闭"><X size={18} /></button>
            </div>
            {privacyAccepted ? (
              <div className="mt-5 overflow-hidden rounded-[8px]">
                {!APP_ACCOUNT_ONLY && <button type="button" disabled={busy} onClick={() => void runPrivacyAction("withdraw")} className="flex w-full items-center gap-3 border-b border-black/[.08] bg-white px-4 py-4 text-left disabled:opacity-50">
                  <ShieldOff size={20} className="text-[#ff9500]" />
                  <span><span className="block text-[15px] font-semibold">撤回人脸处理授权</span><span className="mt-0.5 block text-xs text-[#6e6e73]">停止处理并删除相关影像</span></span>
                </button>}
                <button type="button" disabled={busy} onClick={() => void runPrivacyAction("account")} className="flex w-full items-center gap-3 bg-white px-4 py-4 text-left text-[#d70015] disabled:opacity-50">
                  <UserX size={20} />
                  <span><span className="block text-[15px] font-semibold">注销账号并删除数据</span><span className="mt-0.5 block text-xs text-[#8e454d]">{APP_ACCOUNT_ONLY ? '解除手机号关联和登录会话，安全记录按政策保留' : '删除当前账号、作品与会话'}</span></span>
                </button>
              </div>
            ) : (
              <button type="button" onClick={onRequestPrivacy} className="mt-5 flex w-full items-center gap-3 rounded-[8px] bg-white px-4 py-4 text-left">
                <ShieldCheck size={20} className="text-[#0071e3]" />
                <span><span className="block text-[15px] font-semibold">当前未启用账号服务</span><span className="mt-0.5 block text-xs text-[#6e6e73]">没有服务端数据需要撤回或注销</span></span>
              </button>
            )}

            {!APP_ACCOUNT_ONLY && <button type="button" onClick={() => privacyAccepted ? setReportOpen((value) => !value) : onRequestPrivacy()} className="mt-4 flex w-full items-center gap-3 rounded-[8px] bg-white px-4 py-4 text-left">
              <MessageSquareWarning size={20} className="text-[#d70015]" />
              <span className="min-w-0"><span className="block text-[15px] font-semibold">投诉、举报与申诉</span><span className="mt-0.5 block text-xs text-[#6e6e73]">冒用肖像、未成年人、侵权内容或 AI 标识问题</span></span>
              <ChevronRight size={17} className={`ml-auto shrink-0 text-[#86868b] transition ${reportOpen ? "rotate-90" : ""}`} />
            </button>}
            {!APP_ACCOUNT_ONLY && reportOpen && privacyAccepted && (
              <section className="mt-2 rounded-[8px] bg-white p-4" aria-labelledby="report-title">
                <h3 id="report-title" className="text-[15px] font-semibold">提交问题</h3>
                <label className="mt-3 block text-xs font-medium text-[#6e6e73]">
                  问题类型
                  <select value={reportCategory} onChange={(event) => setReportCategory(event.target.value as SafetyReportCategory)} className="mt-1.5 min-h-11 w-full rounded-[8px] border border-black/[.12] bg-white px-3 text-sm text-[#1d1d1f]">
                    <option value="likeness">未经授权使用肖像</option>
                    <option value="minor">涉及未成年人</option>
                    <option value="rights">版权或其他权利</option>
                    <option value="ai_label">AI 标识缺失或被篡改</option>
                    <option value="harmful">违法或有害内容</option>
                    <option value="other">其他问题</option>
                  </select>
                </label>
                <label className="mt-3 block text-xs font-medium text-[#6e6e73]">
                  问题说明
                  <textarea value={reportDescription} onChange={(event) => setReportDescription(event.target.value.slice(0, 1000))} rows={4} maxLength={1000} placeholder="请说明相关模板或作品，以及需要处理的问题（至少20字）" className="mt-1.5 w-full resize-none rounded-[8px] border border-black/[.12] bg-white p-3 text-sm leading-5 text-[#1d1d1f] placeholder:text-[#a1a1a6]" />
                </label>
                <label className="mt-3 block text-xs font-medium text-[#6e6e73]">
                  联系方式（选填）
                  <input value={reportContact} onChange={(event) => setReportContact(event.target.value.slice(0, 120))} maxLength={120} placeholder="手机号或邮箱，仅用于处理反馈" className="mt-1.5 min-h-11 w-full rounded-[8px] border border-black/[.12] bg-white px-3 text-sm text-[#1d1d1f] placeholder:text-[#a1a1a6]" />
                </label>
                <button type="button" disabled={busy || reportDescription.trim().length < 20} onClick={() => void sendReport()} className="mt-4 min-h-11 w-full rounded-[8px] bg-[#1d1d1f] px-4 text-sm font-semibold text-white disabled:bg-[#d2d2d7]">{busy ? "正在提交…" : "提交"}</button>
                {reportMessage && <p role="status" className="mt-3 rounded-[8px] bg-[#eaf8ed] px-3 py-2 text-xs text-[#248a3d]">{reportMessage}</p>}
              </section>
            )}
            <section className="mt-4 overflow-hidden rounded-[8px] bg-white" aria-label="公开合规信息">
              <div className="border-b border-black/[.08] px-4 py-3">
                <p className="text-[15px] font-semibold">{APP_ACCOUNT_ONLY ? '账号测试协议' : '协议与 AI 服务信息'}</p>
                <p className="mt-1 text-xs text-[#6e6e73]">{APP_ACCOUNT_ONLY ? '了解账号登录、数据使用与您的权利' : '仅展示公司已批准并在生产环境配置的内容'}</p>
              </div>
              {[
                ["隐私政策", compliance?.privacyPolicyUrl],
                ["用户协议", compliance?.userAgreementUrl],
                ...(!APP_ACCOUNT_ONLY ? [["第三方信息共享清单", compliance?.thirdPartyListUrl]] : []),
              ].map(([label, url]) => url ? (
                <a key={label} href={url} target="_blank" rel="noreferrer" className="flex min-h-12 items-center justify-between border-b border-black/[.06] px-4 text-sm font-medium last:border-b-0">
                  {label}<ExternalLink size={15} className="text-[#6e6e73]" />
                </a>
              ) : (
                <div key={label} className="flex min-h-12 items-center justify-between border-b border-black/[.06] px-4 text-sm last:border-b-0">
                  <span>{label}</span><span className="text-xs text-[#86868b]">待公司批准配置</span>
                </div>
              ))}
              {compliance?.aiServices.map((service) => (
                <div key={`${service.provider}-${service.model}`} className="border-t border-black/[.06] px-4 py-3 text-xs leading-relaxed text-[#6e6e73]">
                  <p className="font-semibold text-[#1d1d1f]">{service.provider} · {service.model}</p>
                  <p className="mt-1">{service.purpose} · {service.filingReference}</p>
                </div>
              ))}
              {compliance?.operatorName && <div className="border-t border-black/[.06] px-4 py-3 text-xs text-[#6e6e73]">运营者：{compliance.operatorName}</div>}
              {compliance?.appRecordNumber && <div className="border-t border-black/[.06] px-4 py-3 text-xs text-[#6e6e73]">APP 备案号：{compliance.appRecordNumber}</div>}
              {compliance?.icpFilingNumber && <div className="border-t border-black/[.06] px-4 py-3 text-xs text-[#6e6e73]">ICP备案号：{compliance.icpFilingNumber}</div>}
              {compliance?.supportContact && <div className="border-t border-black/[.06] px-4 py-3 text-xs text-[#6e6e73]">客服与投诉渠道：{compliance.supportContact}</div>}
            </section>
            {actionMessage && <p className="mt-4 rounded-[8px] bg-white px-4 py-3 text-sm leading-relaxed text-[#3a3a3c]">{actionMessage}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorksView({ onMake }: { onMake: () => void }) {
  const { works, loading, error, refresh, remove } = useAccountWorks(!APP_ACCOUNT_ONLY);

  if (APP_ACCOUNT_ONLY) return <p role="status" className="p-6 text-white">{ACCOUNT_ONLY_NOTICE}</p>;

  return (
    <div className="flex h-full flex-col bg-[#f5f5f7] pb-24">
      <header className="px-5 pb-3 pt-7 sm:pt-4">
        <p className="text-[13px] font-medium text-[#0071e3]">个人影集</p>
        <h2 className="mt-1 text-[28px] font-semibold text-[#1d1d1f]">我的作品</h2>
        <p className="mt-1 text-sm text-[#6e6e73]">{works.length} 个作品，按当前账号读取</p>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-3">
        {loading ? (
          <div className="flex min-h-[420px] items-center justify-center text-sm text-[#6e6e73]">正在读取账号作品…</div>
        ) : error ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
            <p className="text-sm text-[#6e6e73]">{error}</p>
            <button type="button" onClick={() => void refresh()} className="mt-4 rounded-[8px] bg-[#1d1d1f] px-5 py-2.5 text-sm font-semibold text-white">重新加载</button>
          </div>
        ) : works.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-[#86868b] shadow-sm ring-1 ring-black/[.06]">
              <ImageOff size={34} strokeWidth={1.6} />
            </div>
            <p className="mt-5 text-[20px] font-semibold text-[#1d1d1f]">还没有作品</p>
            <p className="mt-2 max-w-[240px] text-sm leading-relaxed text-[#6e6e73]">第一部专属影像，会收藏在这里</p>
            <button
              type="button"
              onClick={onMake}
              className="mt-6 rounded-[8px] bg-[#0071e3] px-8 py-3 text-base font-semibold text-white shadow-[0_8px_18px_rgba(0,113,227,.22)]"
            >
              开始创作
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {works.map((work) => (
              <article key={work.id} className="relative overflow-hidden rounded-[8px] border border-black/[.06] bg-white shadow-sm">
                <button type="button" onClick={() => { if (window.confirm("删除这件作品？")) void remove(work.id).catch((cause) => window.alert(cause instanceof Error ? cause.message : "删除失败")); }} className="absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur" aria-label="删除作品"><Trash2 size={16} /></button>
                {work.kind === "video" ? (
                  <video src={work.image} className="aspect-[3/4] w-full bg-black object-cover" controls playsInline preload="metadata" />
                ) : (
                  <img src={work.image} alt={work.templateName} className="aspect-[3/4] w-full object-cover" />
                )}
                <div className="p-3">
                  <p className="truncate text-[15px] font-semibold text-[#1d1d1f]">{work.templateName}</p>
                  <p className="mt-1 text-xs text-[#86868b]">
                    {new Date(work.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
