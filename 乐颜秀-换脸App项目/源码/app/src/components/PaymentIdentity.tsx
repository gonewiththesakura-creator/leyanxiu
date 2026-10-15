import { useState } from 'react';
import { apiFetch, adoptRecoveredSession } from '@/lib/api';
import { AccountLogin } from './AccountLogin';
import type { AccountStatus } from '@/lib/account-login';

export type PaymentIdentityStatus = AccountStatus;
export function PaymentIdentity({ status, onRestored }: {status:PaymentIdentityStatus|null;onRestored:()=>Promise<void>}) {
  const [phone,setPhone]=useState(''); const [code,setCode]=useState('');
  const [purpose,setPurpose]=useState<'bind'|'recover'>('bind');
  const [challenge,setChallenge]=useState(''); const [busy,setBusy]=useState(false); const [notice,setNotice]=useState('');
  const send=async()=>{
    setBusy(true);setNotice('');
    try {
      const response=await apiFetch('/api/account/phone/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,purpose})});
      const body=await response.json(); if(!response.ok || body.code!==0) throw new Error(body.message || '发送失败');
      setChallenge(body.data.challengeId);setNotice('验证码请求已提交，请留意手机短信。验证码 5 分钟内有效；未收到请稍后再试。');
    } catch(error) {setNotice(error instanceof Error?error.message:'发送失败');}
    finally {setBusy(false);}
  };
  const verify=async()=>{
    setBusy(true);setNotice('');
    try {
      const response=await apiFetch('/api/account/phone/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId:challenge,code})});
      const body=await response.json();if(!response.ok || body.code!==0) throw new Error(body.message || '验证失败');
      adoptRecoveredSession(body.data.token);localStorage.removeItem('lyx_payment_attempt_v1');
      setChallenge('');setCode('');setPhone('');await onRestored();setNotice(purpose==='bind'?'手机号绑定成功。':'已找回账号，订单和次数已刷新。');
    } catch(error) {setNotice(error instanceof Error?error.message:'验证失败');}
    finally {setBusy(false);}
  };
  if(status?.loginEnabled) return <AccountLogin status={status}/>;
  return <section className="mb-5 rounded-xl border border-white/10 p-4 text-sm">
    <h2 className="font-semibold">购买保障 · 手机号找回</h2>
    {status?.bound ? <p className="mt-2 text-white/70">已绑定 {status.maskedPhone}。换机或重新安装后，可用此手机号找回账号。</p> :
      status?.available ? <>
        <p className="my-3 leading-6 text-white/65">首次购买请绑定手机号；已有购买记录请选择找回账号。验证码仅用于验证本人，不用于营销。</p>
        <select aria-label="账号验证方式" value={purpose} disabled={busy} onChange={e=>{setPurpose(e.target.value as 'bind'|'recover');setChallenge('');setCode('');}} className="mb-3 w-full rounded bg-zinc-900 p-3"><option value="bind">绑定当前账号</option><option value="recover">找回原账号</option></select>
        <input aria-label="手机号" type="tel" autoComplete="tel" value={phone} maxLength={11} disabled={busy} onChange={e=>{setPhone(e.target.value);setChallenge('');}} placeholder="请输入手机号" className="mb-3 w-full rounded bg-black/30 p-3" />
        <button disabled={busy || !/^1[3-9][0-9]{9}$/.test(phone)} onClick={()=>void send()} className="text-violet-300 disabled:opacity-40">{busy?'处理中…':challenge?'重新获取验证码':'获取验证码'}</button>
        {challenge && <div className="mt-3 flex gap-3"><input aria-label="短信验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} placeholder="6 位验证码" className="min-w-0 flex-1 rounded bg-black/30 p-3" /><button disabled={busy || !/^\d{6}$/.test(code)} onClick={()=>void verify()} className="text-violet-300 disabled:opacity-40">确认</button></div>}
      </> : <p className="mt-2 text-white/60">手机号找回暂未开放，正式购买也会保持关闭。</p>}
    {notice && <p role="status" className="mt-3 leading-6">{notice}</p>}
  </section>;
}
