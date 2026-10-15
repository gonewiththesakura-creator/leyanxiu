export function registerPaymentAccountRoutes(app, { accounts, authenticated, sessionForUser, flush, clientAddress, smsReady, registry, wechatReady=()=>false }) {
  const fail = (c, code, status = 400) => c.json({ code, message: ({ SMS_NOT_CONFIGURED:'手机号验证暂未开放', SMS_RATE_LIMIT:'验证码发送过于频繁，请稍后再试',
    SMS_DELIVERY_UNCONFIRMED:'暂未确认短信发送成功，请稍后重新获取', OTP_INVALID:'验证码错误、已过期或已使用，请重新获取',
    PHONE_BINDING_CONFLICT:'手机号或当前账号已绑定，请使用找回账号或联系客服', RECOVERY_ACCOUNT_NOT_FOUND:'未找到已绑定的账号，请核对手机号',
    ACCOUNT_MERGE_REQUIRES_SUPPORT:'当前账号已有订单或绑定信息，请联系客服处理，不能直接合并' })[code] || '账号验证失败，请核对后重试' }, status);
  app.get('/api/account/payment-identity', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    if(registry) return c.json({code:0,data:{...(await registry.status(auth.auth.userId)),available:smsReady(),wechatAvailable:wechatReady(),loginEnabled:true}});
    return c.json({ code:0,data:{ userId:auth.auth.userId, available:Boolean(accounts) && smsReady(), ...(accounts ? await accounts.status(auth.auth.userId) : {bound:false,maskedPhone:null}) } });
  });
  app.post('/api/account/phone/challenge', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    if (!accounts || !smsReady()) return fail(c,'SMS_NOT_CONFIGURED',503);
    const body = await c.req.json().catch(()=>({}));
    const result = await accounts.challenge({phone:String(body.phone || ''),purpose:body.purpose,deviceUserId:auth.auth.userId,ip:clientAddress(c)});
    return result.error ? fail(c,result.error,result.error==='SMS_RATE_LIMIT'?429:400) : c.json({code:0,data:result});
  });
  app.post('/api/account/phone/verify', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    if (!accounts) return fail(c,'SMS_NOT_CONFIGURED',503);
    const body = await c.req.json().catch(()=>({}));
    const result = await accounts.verify({challengeId:String(body.challengeId || ''),code:String(body.code || ''),deviceUserId:auth.auth.userId});
    if (result.error) return fail(c,result.error);
    const session = sessionForUser(result.userId);
    await flush();
    c.header('Cache-Control','no-store');
    return c.json({code:0,data:session});
  });
}
