import { useState } from "react";
import { Check, Eye, ShieldCheck } from "lucide-react";
import { openExternalUrl } from "@/lib/native";
import { CLOSED_TEST_INVITE_REQUIRED } from "@/lib/api";
import { APP_ACCOUNT_ONLY } from '@/lib/account-only';

const PRIVACY_POLICY_URL = import.meta.env.VITE_PRIVACY_POLICY_URL || "";
const USER_AGREEMENT_URL = import.meta.env.VITE_USER_AGREEMENT_URL || "";
const POLICIES_READY = /^https:\/\//.test(PRIVACY_POLICY_URL) && /^https:\/\//.test(USER_AGREEMENT_URL);

function PolicyLink({ href, children }: { href: string; children: string }) {
  if (!href) return <span className="font-medium text-[#6e6e73]">{children}</span>;
  return <button type="button" onClick={() => void openExternalUrl(href)} className="min-h-0 p-0 font-semibold text-[#0071e3] underline underline-offset-2">{children}</button>;
}

export function PrivacyGate({ productName, onAccept, onBrowse }: { productName: string; onAccept: (inviteCode?: string) => void | Promise<void>; onBrowse: () => void }) {
  const [adultAttested, setAdultAttested] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleAccept = async () => {
    if (!adultAttested || submitting || (APP_ACCOUNT_ONLY && !POLICIES_READY)) return;
    if (CLOSED_TEST_INVITE_REQUIRED && !inviteCode.trim()) {
      setError("请输入闭测邀请码");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await onAccept(CLOSED_TEST_INVITE_REQUIRED ? inviteCode.trim() : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "验证失败，请检查邀请码后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-end justify-center bg-black px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))] text-[#1d1d1f] sm:items-center">
      <section role="dialog" aria-modal="true" aria-labelledby="privacy-title" className="w-full max-w-[420px] rounded-[8px] bg-[#f5f5f7] p-5 shadow-[0_24px_70px_rgba(0,0,0,.5)]">
        <div className="flex h-12 w-12 items-center justify-center rounded-[8px] bg-[#eaf8ed] text-[#248a3d]">
          <ShieldCheck size={26} />
        </div>
        <h1 id="privacy-title" className="mt-5 text-[24px] font-semibold">欢迎使用{productName}</h1>
        <p className="mt-3 text-sm leading-6 text-[#5d5d62]">
          {APP_ACCOUNT_ONLY ? '本次仅开放受邀账号测试，可测试手机号登录、退出和注销。创作、照片上传和购买暂未开放。同意前不会连接服务端、创建账号标识或读取照片，也可以先浏览本地模板。' : '同意前不会连接服务端、创建用户标识或读取照片。你也可以先在不联网的模式下浏览模板；真正制作时，再单独确认人脸影像处理。'}
        </p>
        <div className="mt-4 rounded-[8px] border border-black/[.07] bg-white p-4 text-xs leading-5 text-[#5d5d62]">
          <p>{APP_ACCOUNT_ONLY ? '同意后，为提供账号登录和安全保护，应用会处理应用生成的设备标识、设备公钥、登录会话和必要安全记录。主动输入手机号并获取验证码时，将通过阿里云短信发送验证码。' : '同意后，为提供作品生成和账号数据控制，应用会处理设备生成的账号标识、必要安全日志，以及你主动选择的照片和生成结果。'}</p>
          <p className="mt-2">{APP_ACCOUNT_ONLY ? '本次测试不收取服务费。不会读取通讯录、短信收件箱或定位；第三方服务、保存期限和注销说明见隐私政策。' : '照片只在你确认制作后上传。处理目的、服务商和保存期限会在上传前再次展示。'}</p>
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-[8px] border border-black/[.08] bg-white p-3.5">
          <input type="checkbox" checked={adultAttested} onChange={(event) => setAdultAttested(event.target.checked)} className="sr-only" />
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border ${adultAttested ? "border-[#0071e3] bg-[#0071e3] text-white" : "border-[#b7b7bb] bg-white text-transparent"}`} aria-hidden="true"><Check size={14} strokeWidth={3} /></span>
          <span className="text-xs leading-5 text-[#5d5d62]">{APP_ACCOUNT_ONLY ? '我已年满 18 周岁，并使用本人合法持有的手机号参加账号测试。' : '我已年满 18 周岁，并承诺仅上传本人照片，或已获得照片中人物的明确授权。'}</span>
        </label>
        {CLOSED_TEST_INVITE_REQUIRED ? (
          <label className="mt-4 block text-xs font-semibold text-[#5d5d62]">
            闭测邀请码
            <input
              value={inviteCode}
              onChange={(event) => { setInviteCode(event.target.value); setError(""); }}
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              placeholder="请输入邀请码"
              className="mt-2 w-full rounded-[8px] border border-black/[.1] bg-white px-3 py-3 text-sm font-normal text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:ring-2 focus:ring-[#0071e3]/15"
            />
          </label>
        ) : null}
        <p className="mt-4 text-xs leading-5 text-[#6e6e73]">
          点击“同意并进入”即表示你已阅读并同意 <PolicyLink href={USER_AGREEMENT_URL}>《用户协议》</PolicyLink> 和 <PolicyLink href={PRIVACY_POLICY_URL}>《隐私政策》</PolicyLink>。
        </p>
        {!PRIVACY_POLICY_URL || !USER_AGREEMENT_URL ? (
          <p className="mt-2 rounded-[8px] bg-[#fff4e5] px-3 py-2 text-xs text-[#8a5200]">当前为内部测试包，正式发布前必须配置公司批准的协议链接。</p>
        ) : null}
        {error ? <p role="alert" className="mt-3 rounded-[8px] bg-[#fff0f0] px-3 py-2 text-xs leading-5 text-[#b42318]">{error}</p> : null}
        <button type="button" disabled={!adultAttested || submitting || (APP_ACCOUNT_ONLY && !POLICIES_READY) || (CLOSED_TEST_INVITE_REQUIRED && !inviteCode.trim())} onClick={() => void handleAccept()} className="mt-5 w-full rounded-[8px] bg-[#0071e3] py-3.5 text-base font-semibold text-white disabled:bg-[#d2d2d7] disabled:text-[#86868b]">{submitting ? "正在验证…" : "同意并进入"}</button>
        <button type="button" onClick={onBrowse} className="mt-2 flex w-full items-center justify-center gap-1.5 py-3 text-sm font-medium text-[#6e6e73]">
          <Eye size={15} /> 不同意，仅浏览本地模板
        </button>
      </section>
    </main>
  );
}
