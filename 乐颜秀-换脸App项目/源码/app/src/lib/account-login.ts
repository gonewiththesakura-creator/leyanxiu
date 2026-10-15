import { registerPlugin } from '@capacitor/core';
import { apiFetch, adoptRecoveredSession, clearAccountSession } from './api';
import { IS_NATIVE_APP } from './native';

export interface AccountStatus {
  available:boolean;bound:boolean;maskedPhone:string|null;loginEnabled?:boolean;
  loggedIn?:boolean;userId?:string;wechatAvailable?:boolean;wechatLinked?:boolean;
}
const WechatLogin=registerPlugin<{
  start(input:{appId:string;state:string}):Promise<{launched:boolean}>;
  result():Promise<{error?:number;code?:string;state?:string}>;
}>('WechatLogin');

export async function accountRequest<T>(path:string,body?:unknown):Promise<T> {
  const response=await apiFetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},body===undefined);
  const json=await response.json();
  if(!response.ok || json.code!==0) throw new Error(json.message || '账号操作未完成');
  return json.data as T;
}
export function loginStatus() {return accountRequest<AccountStatus>('/api/account/payment-identity');}
export async function finishPhoneLogin(challengeId:string,code:string) {
  const data=await accountRequest<{token:string}>('/api/account/login/phone/verify',{challengeId,code,termsVersion:'account-v1'});
  adoptRecoveredSession(data.token);
}
export async function loginWithWechat(purpose:'login'|'link') {
  if(!IS_NATIVE_APP) throw new Error('请在 Android App 中使用微信登录');
  const pending=await accountRequest<{appId:string;state:string}>('/api/account/login/wechat/start',{purpose,termsVersion:'account-v1'});
  await WechatLogin.start(pending);
  const deadline=Date.now()+180000;
  while(Date.now()<deadline) {
    const result=await WechatLogin.result();
    if(result.error!==undefined) {
      if(result.error!==0) throw new Error(result.error===-2?'已取消微信授权':'微信授权未成功，请使用手机号登录');
      if(result.state!==pending.state || !result.code) throw new Error('微信授权不匹配，请重新登录');
      const data=await accountRequest<{token:string}>('/api/account/login/wechat/verify',{code:result.code,state:result.state});
      adoptRecoveredSession(data.token);return;
    }
    await new Promise(resolve=>window.setTimeout(resolve,750));
  }
  throw new Error('微信授权已超时，请重新尝试');
}
export async function logoutAccount(all=false) {
  await accountRequest('/api/account/login/logout',{all});
  clearAccountSession();
}
