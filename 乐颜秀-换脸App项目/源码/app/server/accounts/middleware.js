// Check the durable device mapping on every authenticated request. A valid signature
// alone cannot keep an old account session alive after logout or account switching.
export function accountSessionGuard({registry,getAuth,accountOnly=process.env.APP_ACCOUNT_ONLY==='true'}) {
  return async(c,next)=> {
    if(c.req.path.startsWith('/api/account/phone/')) return c.json({code:'LOGIN_FLOW_REQUIRED',message:'请使用新版账号登录入口'},409);
    const auth=getAuth(c);
    if(auth && !await registry.validSession(auth)) return c.json({code:'AUTH_REQUIRED',message:'登录已失效，请重新登录'},401);
    // First-screen basic consent precedes phone login in the account test. The
    // consent handler still enforces type/version; this is not a general write bypass.
    const bootstrapConsent=accountOnly && c.req.method==='POST'
      && ['/api/consents','/api/consents/basic/withdraw'].includes(c.req.path);
    if(auth?.authMethod==='device_bootstrap' && !bootstrapConsent && !['GET','HEAD','OPTIONS'].includes(c.req.method)
      && !c.req.path.startsWith('/api/account/login/') && !c.req.path.startsWith('/api/auth/device/') && c.req.path!=='/api/auth/logout') {
      return c.json({code:'LOGIN_REQUIRED',message:'请到“我的”登录账号后继续'},403);
    }
    return next();
  };
}
