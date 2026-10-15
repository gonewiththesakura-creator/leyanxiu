export function registerAppAccountRoutes(app,{registry,otp,authenticated,sessionForUser,flush,users,clientAddress,smsReady,wechatReady,wechatExchange,appId,rateLimit}) {
  const fail=(c,error,status=400)=>c.json({code:error,message:({
    LOGIN_NOT_CONFIGURED:'账号登录暂未开放',SMS_RATE_LIMIT:'验证码发送过于频繁，请稍后再试',SMS_DELIVERY_UNCONFIRMED:'短信发送未确认，请稍后重试',
    OTP_INVALID:'验证码错误、已过期或已使用',ACCOUNT_UNAVAILABLE:'账号不可用，请联系客服',
    ACCOUNT_LINK_CONFLICT:'登录方式已关联其他账号，请使用原登录方式，不会合并套餐',
    RECENT_PHONE_LOGIN_REQUIRED:'请先使用原登录方式重新登录，再添加备用登录方式',LOGIN_STATE_INVALID:'本次登录验证已失效，请重新操作',
    WECHAT_LOGIN_FAILED:'微信登录未成功，请重试或使用手机号',WECHAT_NOT_READY:'微信登录暂未开放，请使用手机号',
    LOGIN_RATE_LIMIT:'操作过于频繁，请稍后重试',TERMS_REQUIRED:'请先阅读并同意用户协议和隐私政策',
  })[error] || '登录未完成，请重新尝试'},status);
  const identity=c=>{
    const result=authenticated(c);
    if(result.response) return result;
    if(!registry || !result.auth.deviceId) return {response:fail(c,'LOGIN_NOT_CONFIGURED',503)};
    return result;
  };
  async function complete(c,result,method) {
    if(result.error) return fail(c,result.error);
    if(!result.deviceId || !result.deviceVersion) return fail(c,'LOGIN_NOT_CONFIGURED',503);
    let session;
    // A failed durable write must not leave a device able to silently resume the account.
    try {
      session=sessionForUser(result.userId,{authMethod:method,deviceId:result.deviceId,deviceVersion:result.deviceVersion,authenticatedAt:Date.now()});
      await flush();
    } catch {
      await registry.logout(result);
      // Even if the session store is still unwritable, the durable device version is revoked.
      try {users.revokeUserSessions(result.userId,'login_persistence_failed');} catch { /* device guard remains authoritative */ }
      return fail(c,'LOGIN_NOT_CONFIGURED',503);
    }
    c.header('Cache-Control','no-store');
    return c.json({code:0,data:session});
  }
  app.get('/api/account/login-status',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    c.header('Cache-Control','no-store');
    return c.json({code:0,data:{...(await registry.status(auth.auth.userId)),available:smsReady(),wechatAvailable:wechatReady(),loginEnabled:true}});
  });
  app.post('/api/account/login/phone/challenge',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    if(!smsReady()) return fail(c,'LOGIN_NOT_CONFIGURED',503);
    const body=await c.req.json().catch(()=>({}));
    if(body.termsVersion!=='account-v1') return fail(c,'TERMS_REQUIRED');
    const linking=body.purpose==='link-phone';
    if(linking && (!['wechat-app','phone'].includes(auth.auth.authMethod) || !Number.isFinite(auth.auth.authenticatedAt) || Date.now()-auth.auth.authenticatedAt>300000)) return fail(c,'RECENT_PHONE_LOGIN_REQUIRED');
    const result=await otp.challenge({phone:body.phone,purpose:linking?'link-phone':'login',deviceUserId:auth.auth.deviceId,ip:clientAddress(c),loginUserId:auth.auth.userId,deviceVersion:auth.auth.deviceVersion});
    return result.error ? fail(c,result.error,result.error==='SMS_RATE_LIMIT'?429:400) : c.json({code:0,data:result});
  });
  app.post('/api/account/login/phone/verify',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    const body=await c.req.json().catch(()=>({}));
    if(body.termsVersion!=='account-v1') return fail(c,'TERMS_REQUIRED');
    const result=await otp.verify({challengeId:String(body.challengeId||''),code:String(body.code||''),deviceUserId:auth.auth.deviceId,expectedPurpose:['login','link-phone']});
    return complete(c,result,'phone');
  });
  app.post('/api/account/login/wechat/start',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    if(!wechatReady()) return fail(c,'WECHAT_NOT_READY',503);
    const body=await c.req.json().catch(()=>({}));
    if(body.termsVersion!=='account-v1') return fail(c,'TERMS_REQUIRED');
    if(!rateLimit(`${clientAddress(c)}:wechat-login`,10)) return fail(c,'LOGIN_RATE_LIMIT',429);
    const result=await registry.startWechat(auth.auth,body.purpose || 'login');
    return result.error ? fail(c,result.error) : c.json({code:0,data:{...result,appId:appId()}});
  });
  app.post('/api/account/login/wechat/verify',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    if(!wechatReady()) return fail(c,'WECHAT_NOT_READY',503);
    const body=await c.req.json().catch(()=>({}));
    const challenge=await registry.consumeWechat(auth.auth,String(body.state||''));
    if(challenge.error) return fail(c,challenge.error);
    let provider;
    try {provider=await wechatExchange(String(body.code||''));} catch {return fail(c,'WECHAT_LOGIN_FAILED');}
    return complete(c,await registry.finishWechat(auth.auth,challenge,provider),'wechat-app');
  });
  app.post('/api/account/login/logout',async c=> {
    const auth=identity(c);if(auth.response) return auth.response;
    const body=await c.req.json().catch(()=>({}));
    await registry.logout(auth.auth,body.all===true);
    // Current account sessions are revoked as well; other devices can use their own proof to resume unless all=true.
    users.revokeUserSessions(auth.auth.userId,'account_logout');
    await flush();
    return c.json({code:0,data:{loggedOut:true}});
  });
}
