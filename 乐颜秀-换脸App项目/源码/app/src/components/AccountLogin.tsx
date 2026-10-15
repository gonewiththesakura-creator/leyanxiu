import { useEffect, useRef, useState } from 'react';
import { accountRequest, finishPhoneLogin, loginStatus, loginWithWechat, logoutAccount, type AccountStatus } from '@/lib/account-login';
import { IS_NATIVE_APP } from '@/lib/native';
import { APP_ACCOUNT_ONLY } from '@/lib/account-only';

export function AccountLogin({status:initialStatus,onChanged=()=>window.location.reload()}:{status:AccountStatus;onChanged?:()=>void}) {
  const [phone,setPhone]=useState('');const [code,setCode]=useState('');const [challenge,setChallenge]=useState('');
  const [accepted,setAccepted]=useState(false);const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');
  const [remaining,setRemaining]=useState(0);const lock=useRef(false);
  const [linkPhone,setLinkPhone]=useState(false);
  useEffect(()=>{if(!remaining)return;const timer=window.setTimeout(()=>setRemaining(n=>Math.max(0,n-1)),1000);return()=>window.clearTimeout(timer);},[remaining]);
  async function run(operation:()=>Promise<void>) {
    if(lock.current)return;lock.current=true;setBusy(true);setNotice('');
    try {await operation();} catch(error) {setNotice(error instanceof Error?error.message:'操作失败，请重试');}
    finally {lock.current=false;setBusy(false);}
  }
  const status=APP_ACCOUNT_ONLY ? {...initialStatus,wechatAvailable:false} : initialStatus;
  const agreement=import.meta.env.VITE_USER_AGREEMENT_URL || '';
  const privacy=import.meta.env.VITE_PRIVACY_POLICY_URL || '';
  const policiesReady=/^https:\/\//.test(agreement) && /^https:\/\//.test(privacy);
  return <section className="my-4 rounded-xl border border-white/15 bg-[#17171a] p-4 text-white" aria-label="乐颜秀账号">
    <h2 className="text-lg font-semibold">{status.loggedIn?'我的账号':'登录乐颜秀'}</h2>
    {status.loggedIn && !linkPhone ? <>
      <p className="mt-2 text-sm text-white/70">{status.maskedPhone || '微信账号'}{status.wechatLinked?' · 已关联微信':''}</p>
      <p className="mt-1 break-all text-xs text-white/50">账号：{status.userId}</p>
      <p className="my-3 text-sm leading-6">{APP_ACCOUNT_ONLY ? '换手机后使用同一手机号登录，可回到此账号。本次测试暂未开放购买和创作。' : '套餐和订单归属于此账号，换手机后使用原登录方式即可查看。'}</p>
      {status.available && !status.maskedPhone && <button disabled={busy} onClick={()=>setLinkPhone(true)} className="mb-3 min-h-12 w-full rounded-lg border border-white/20 px-4">添加手机号备用登录</button>}
      {status.wechatAvailable && !status.wechatLinked && IS_NATIVE_APP && <button disabled={busy} onClick={()=>void run(async()=>{await loginWithWechat('link');onChanged();})} className="mb-3 min-h-12 w-full rounded-lg bg-green-700 px-4 disabled:opacity-40">关联微信，下次快捷登录</button>}
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} onClick={()=>void run(async()=>{await logoutAccount();onChanged();})} className="min-h-12 rounded-lg border border-white/20 px-4 disabled:opacity-40">退出 / 切换账号</button>
        <button disabled={busy} onClick={()=>{if(window.confirm('所有设备都需要重新登录，确定继续？'))void run(async()=>{await logoutAccount(true);onChanged();});}} className="min-h-12 px-2 text-sm text-white/65 disabled:opacity-40">退出所有设备</button>
      </div>
    </> : <>
      <p className="my-3 text-sm leading-6 text-white/70">{APP_ACCOUNT_ONLY ? '使用手机号验证码登录。已有账号请使用原手机号，当前暂未开放购买和创作。' : linkPhone?'为当前账号添加备用登录方式，不会转移或合并其他账号的套餐。':'登录后购买和使用套餐。已有账号请使用原登录方式。'}</p>
      {policiesReady ? <label className="mb-4 flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={accepted} disabled={busy} onChange={e=>setAccepted(e.target.checked)} className="mt-1 h-5 w-5"/><span>我已阅读并同意<a href={agreement} target="_blank" rel="noopener noreferrer" className="text-violet-300 underline">用户协议</a>和<a href={privacy} target="_blank" rel="noopener noreferrer" className="text-violet-300 underline">隐私政策</a>。{!linkPhone && '未注册的手机号验证后将创建账号。'}</span></label> : <p className="mb-3 text-sm">登录协议准备中，暂未开放登录。</p>}
      {!linkPhone && status.wechatAvailable && IS_NATIVE_APP && <button disabled={busy || !accepted || !policiesReady} onClick={()=>void run(async()=>{await loginWithWechat('login');onChanged();})} className="mb-4 min-h-12 w-full rounded-lg bg-green-700 px-4 text-lg disabled:opacity-40">微信快捷登录</button>}
      {status.available ? <>
        <label className="block text-sm">手机号<input aria-label="登录手机号" type="tel" autoComplete="tel-national" inputMode="tel" maxLength={11} value={phone} disabled={busy} onChange={e=>{setPhone(e.target.value.replace(/\D/g,''));setChallenge('');setCode('');}} className="mt-2 block min-h-12 w-full rounded-lg bg-black/30 px-3 text-lg"/></label>
        <button disabled={busy || !accepted || !policiesReady || remaining>0 || !/^1[3-9]\d{9}$/.test(phone)} onClick={()=>void run(async()=>{const result=await accountRequest<{challengeId:string}>('/api/account/login/phone/challenge',{phone,termsVersion:'account-v1',purpose:linkPhone?'link-phone':'login'});setChallenge(result.challengeId);setRemaining(60);setNotice('验证码请求已提交，请留意手机短信。验证码 5 分钟内有效；未收到请稍后再试。');})} className="my-3 min-h-12 rounded-lg border border-white/20 px-4 disabled:opacity-40">{remaining?`${remaining} 秒后重新获取`:'获取验证码'}</button>
        {challenge && <><label className="block text-sm">验证码<input aria-label="登录验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} className="mt-2 block min-h-12 w-full rounded-lg bg-black/30 px-3 text-lg"/></label><button disabled={busy || !accepted || code.length!==6} onClick={()=>void run(async()=>{await finishPhoneLogin(challenge,code);onChanged();})} className="mt-4 min-h-12 w-full rounded-lg bg-violet-600 px-4 text-lg disabled:opacity-40">登录</button></>}
      </> : <p className="text-sm text-white/65">手机号登录暂未开放。</p>}
    </>}
    {busy && <p role="status" className="mt-3 text-sm">正在处理，请稍候…</p>}
    {notice && <p role="status" className="mt-3 text-sm leading-6">{notice}</p>}
  </section>;
}

export function AccountCenter() {
  const [status,setStatus]=useState<AccountStatus|null>(null);const [error,setError]=useState('');
  useEffect(()=>{let active=true;void loginStatus().then(value=>{if(active)setStatus(value);}).catch(()=>{if(active)setError('账号状态暂时无法读取，请稍后重新进入。');});return()=>{active=false;};},[]);
  if(error)return <p role="status" className="my-3 text-sm text-white/70">{error}</p>;
  return status?.loginEnabled ? <AccountLogin status={status}/> : null;
}
