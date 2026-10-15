export function wechatLoginReady(env=process.env) {
  return env.APP_LOGIN_ENABLED==='true' && env.WECHAT_LOGIN_APPROVED==='true'
    && /^wx[0-9a-z]{16}$/i.test(env.WECHAT_LOGIN_APP_ID || '') && Boolean(env.WECHAT_LOGIN_APP_SECRET);
}

export function createWechatLogin({ appId, secret, fetchImpl=fetch }) {
  if(!/^wx[0-9a-z]{16}$/i.test(appId || '') || !secret) throw new Error('WECHAT_LOGIN_NOT_CONFIGURED');
  return async code => {
    if(typeof code!=='string' || !/^[a-zA-Z0-9_-]{8,512}$/.test(code)) throw new Error('WECHAT_CODE_INVALID');
    const url=new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    url.search=new URLSearchParams({appid:appId,secret,code,grant_type:'authorization_code'}).toString();
    // Never log the URL, response tokens or transport errors containing credentials.
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10000);
    try {
      const response=await fetchImpl(url,{redirect:'error',signal:controller.signal});
      const body=await response.json();
      if(!response.ok || body.errcode || typeof body.openid!=='string' || !/^[\w-]{8,128}$/.test(body.openid)
        || typeof body.access_token!=='string' || !body.access_token) throw new Error('WECHAT_LOGIN_FAILED');
      // Scope identity by AppID. UnionID alone never silently merges paid business accounts.
      return {appId,openid:body.openid};
    } catch {throw new Error('WECHAT_LOGIN_FAILED');}
    finally {clearTimeout(timer);}
  };
}
