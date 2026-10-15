import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AccountCenter} from '../src/components/AccountLogin';
import {accountRequest} from '../src/lib/account-login';
import '../src/index.css';
export function Preview(){
  const [balance,setBalance]=useState<number|null>(null);const [code,setCode]=useState('');
  useEffect(()=>{void accountRequest<{totalRemaining:number}>('/api/account/entitlements').then(value=>setBalance(value.totalRemaining));const timer=window.setInterval(()=>{void fetch('/fixture/code').then(r=>r.json()).then(value=>setCode(value.code));},1000);return()=>window.clearInterval(timer);},[]);
  return <main className="mx-auto min-h-screen max-w-md bg-[#0e0e11] p-4 text-white"><p className="text-sm text-amber-200">本地隔离验证：模拟短信与设备认证，无真实扣费。</p><p className="my-3">测试账号 13800000000 · 预置 3 次套餐</p><AccountCenter/><p aria-label="套餐余额">当前账号剩余：{balance??'读取中'} 次</p><p className="my-4 text-sm text-amber-200">模拟短信验证码：{code||'尚未发送'}</p></main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
