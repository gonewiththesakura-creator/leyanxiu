/* Native WeChat client. No app secret, appKey or session_key belongs in this project. */
function createPaymentClient(wxApi, endpoint) {
  const cloud = endpoint && typeof endpoint === 'object' && endpoint.mode === 'cloud'
    ? { env: endpoint.env, service: endpoint.service } : null;
  const apiBase = typeof endpoint === 'string' ? endpoint : '';
  if (cloud) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(cloud.env || '') || !/^[a-z][a-z0-9-]{0,62}$/.test(cloud.service || '')) throw new Error('支付服务尚未配置完成');
    if (typeof wxApi.cloud?.callContainer !== 'function') throw new Error('当前微信版本不支持云服务，请升级微信后重试');
  } else if (!/^https:\/\/[A-Za-z0-9.-]+(?::443)?$/.test(apiBase)) throw new Error('请先配置已登记的 HTTPS 服务域名');
  let session; let loginTask; let accountId; let accountChanged = false;
  let active = true, revision = 0;
  const inactiveError = () => Object.assign(new Error('页面已离开，本次操作已停止；已有订单请重新连接后查询，勿重复付款'), { code: 'XPAY_PAGE_INACTIVE' });
  const assertActive = operationRevision => { if (!active || operationRevision !== revision) throw inactiveError(); };
  const invoke = (method, args = {}) => new Promise((resolve, reject) => wxApi[method]({ ...args, success: resolve, fail: reject }));
  const identityError = () => { const error = new Error('微信账号已变化，请重新打开页面后查看当前账号的订单'); error.code = 'XPAY_ACCOUNT_CHANGED'; return error; };
  const authenticationRejected = error => error.statusCode === 401 || ['AUTH_EXPIRED', 'SESSION_EXPIRED', 'AUTH_SESSION_EXPIRED'].includes(error.code);
  const send = async (url, { method = 'GET', data, idempotencyKey, timeout = 15000, acceptPartialErasure = false } = {}, auth, operationRevision = revision) => {
    assertActive(operationRevision);
    // Cloud.callContainer accepts at most 15 seconds. A longer synchronous
    // creation deadline cannot bypass this platform transport limit.
    const options = { method, data, timeout: cloud ? Math.min(timeout, 15000) : timeout,
      header: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } };
    // Cloud failure is never retried through a different/public transport.
    const response = cloud
      ? await wxApi.cloud.callContainer({ ...options, config: { env: cloud.env }, path: url, header: { ...options.header, 'X-WX-SERVICE': cloud.service } })
      : await invoke('request', { ...options, url: `${apiBase}${url}` });
    const partialErasure = acceptPartialErasure && response.statusCode === 202 && response.data?.code === 'ERASURE_PARTIAL';
    if (response.statusCode < 200 || response.statusCode >= 300 || (response.data?.code !== 0 && !partialErasure)) {
      const error = new Error(response.data?.message || '服务暂不可用，请稍后刷新'); error.code = response.data?.code; error.statusCode = response.statusCode; throw error;
    }
    return partialErasure ? { ...response.data.data, erasurePartial: true } : response.data.data;
  };
  const loginAt = async operationRevision => {
    assertActive(operationRevision);
    if (accountChanged) throw identityError();
    if (!loginTask || loginTask.revision !== operationRevision) loginTask = { revision: operationRevision, promise: (async () => {
      const result = await invoke('login');
      assertActive(operationRevision);
      // Login never uses an expired bearer token or recursively retries authentication.
      const refreshed = await send('/api/auth/wechat', { method: 'POST', data: { code: result.code } }, undefined, operationRevision);
      assertActive(operationRevision);
      if (typeof refreshed?.token !== 'string' || !refreshed.token || typeof refreshed.user?.id !== 'string' || !refreshed.user.id) throw new Error('登录结果尚未确认，请重试');
      if (accountId && accountId !== refreshed.user.id) { session = undefined; accountChanged = true; throw identityError(); }
      accountId = refreshed.user.id; session = refreshed; return session;
    })() };
    const task = loginTask;
    try { const result = await task.promise; assertActive(operationRevision); return result; }
    finally { if (loginTask === task) loginTask = undefined; }
  };
  const login = () => loginAt(revision);
  const requestAt = async (url, options, operationRevision, rememberResponse) => {
    assertActive(operationRevision);
    if (accountChanged) throw identityError();
    const attempted = session || await loginAt(operationRevision);
    assertActive(operationRevision);
    const receive = data => {
      if (accountChanged) throw identityError();
      // A POST already sent can create an order after the page hides. The only
      // allowed late write records that receipt under its original account/key;
      // it cannot authorize a new request or open the native cashier.
      rememberResponse?.(data);
      assertActive(operationRevision);
      return data;
    };
    try {
      return receive(await send(url, options, attempted, operationRevision));
    } catch (error) {
      assertActive(operationRevision);
      // Only a definite authentication rejection permits one replay. Network failures do not.
      if (!authenticationRejected(error)) throw error;
      if (session === attempted) session = undefined;
      const refreshed = session || await loginAt(operationRevision);
      assertActive(operationRevision);
      try {
        return receive(await send(url, options, refreshed, operationRevision));
      } catch (retryError) {
        if (authenticationRejected(retryError) && session === refreshed) session = undefined;
        throw retryError;
      }
    }
  };
  const request = (url, options) => requestAt(url, options, revision);
  const pendingKey = () => `lyx-payment-pending:${accountId}`;
  const confirmationError = code => { const error = new Error(code === 'XPAY_PAYMENT_CONFIRMATION_REQUIRED'
    ? '请先确认本次套餐金额和支付环境' : '订单金额、商品或支付环境与确认内容不符，已保留订单，请先核实，勿重复付款'); error.code = code; return error; };
  const purchaseAvailability = catalog => {
    // The server owns the supported scope. Device information is a UI guard,
    // not proof accepted by the server or permission to change that scope.
    if (catalog?.ledgerOnlySandbox === true) return { supported: true, available: catalog.available === true };
    let platform;
    try { platform = (wxApi.getDeviceInfo ? wxApi.getDeviceInfo() : wxApi.getSystemInfoSync()).platform; } catch {}
    const scoped = catalog?.purchaseProfile === 'android-only-v1' && Array.isArray(catalog.supportedPlatforms)
      && catalog.supportedPlatforms.length === 1 && catalog.supportedPlatforms[0] === 'android';
    const supported = scoped && platform === 'android';
    return { supported, available: supported && catalog.available === true,
      message: scoped && !supported ? '当前终端暂不支持购买，已有订单和权益仍可查询。' : '购买暂未开放，已有订单仍可查询。' };
  };
  const unsupportedPurchase = () => Object.assign(new Error('当前终端暂不支持购买，已有订单和权益仍可查询。'),
    { code: 'XPAY_PURCHASE_PLATFORM_UNSUPPORTED' });
  const refreshOrderAt = async (orderId, operationRevision) => {
    const order = await requestAt(`/api/mini/payments/orders/${encodeURIComponent(orderId)}`, undefined, operationRevision);
    assertActive(operationRevision);
    if (session && ['paid', 'refunded', 'closed'].includes(order.status)) {
      const pending = wxApi.getStorageSync(pendingKey());
      if (pending?.orderId === orderId) wxApi.removeStorageSync(pendingKey());
    }
    return order;
  };
  let paying = false;
  return {
    setActive(value) { const next = value === true; if (next !== active) { active = next; revision++; } },
    login,
    // Share the same account-bound authentication contract with native creation.
    // This does not change payment readiness, prices or entitlement decisions.
    request,
    currentAccountId: () => accountChanged ? null : accountId,
    products: () => request('/api/mini/payments/products'),
    purchaseAvailability,
    entitlements: () => request('/api/mini/payments/entitlements'),
    orders: () => request('/api/mini/payments/orders'),
    refunds: () => request('/api/mini/payments/refunds'),
    refund: (orderId, reason) => request(`/api/mini/payments/orders/${encodeURIComponent(orderId)}/refund`, { method: 'POST', data: { reason } }),
    confirmSandboxRefund: refundId => request(`/api/mini/payments/sandbox/refunds/${encodeURIComponent(refundId)}/confirm`, { method: 'POST', data: { confirm: true } }),
    refreshOrder: orderId => refreshOrderAt(orderId, revision),
    async buy(productId, rulesVersion, confirmation) {
      const operationRevision = revision;
      assertActive(operationRevision);
      if (paying) throw new Error('上一笔支付正在确认，请稍候');
      paying = true;
      try {
        if (accountChanged) throw identityError();
        if (!wxApi.canIUse('requestVirtualPayment')) throw new Error('当前微信版本不支持购买，请升级微信后重试');
        const device = wxApi.getDeviceInfo ? wxApi.getDeviceInfo() : wxApi.getSystemInfoSync();
        if (!['android', 'ios', 'windows'].includes(device.platform)) throw new Error('请在支持支付的微信客户端中购买');
        // These are local confirmation guards, never client-supplied prices sent
        // to the server. Snapshot before login/network awaits or caller mutation.
        const expectedAmountFen = confirmation?.expectedAmountFen;
        const expectedProductId = confirmation?.expectedProductId;
        const expectedEnv = confirmation?.expectedEnv;
        const validateFreshCatalog = confirmation?.validateFreshCatalog;
        if (validateFreshCatalog !== undefined && typeof validateFreshCatalog !== 'function') throw confirmationError('XPAY_PAYMENT_CONFIRMATION_REQUIRED');
        if (!Number.isSafeInteger(expectedAmountFen) || expectedAmountFen <= 0 || expectedAmountFen > 100000
          || expectedProductId !== productId || !/^[A-Za-z0-9_-]{1,64}$/.test(expectedProductId || '')
          || ![0, 1].includes(expectedEnv)) throw confirmationError('XPAY_PAYMENT_CONFIRMATION_REQUIRED');
        if (expectedEnv === 0 && device.platform !== 'android') throw unsupportedPurchase();
        // Fresh login obtains a fresh server-held session key. Preserve pending attempts across refresh/restart.
        await loginAt(operationRevision);
        assertActive(operationRevision);
        const storageKey = pendingKey();
        let pending = wxApi.getStorageSync(pendingKey());
        if (pending?.orderId) {
          const existing = await refreshOrderAt(pending.orderId, operationRevision);
          assertActive(operationRevision);
          if (existing.status === 'pending' && (!existing.paymentRetryable || pending.nativePaymentStarted === true)) return { order: existing, pending: true, message: '上一笔订单仍在确认，请到订单记录刷新，勿重复付款' };
          if (existing.status === 'paid') return { order: existing, pending: false };
          if (existing.status !== 'pending') pending = null;
        }
        if (pending && pending.productId !== productId) throw new Error('上一笔订单尚未确认，请先重试原套餐以找回订单');
        if (expectedEnv === 0 || validateFreshCatalog) {
          // Recheck the current server profile before a new order/signature;
          // a cached catalog or a caller-supplied profile cannot open sales.
          const currentCatalog = await requestAt('/api/mini/payments/products', undefined, operationRevision);
          assertActive(operationRevision);
          if (expectedEnv === 0) {
            const capability = purchaseAvailability(currentCatalog);
            if (currentCatalog?.ledgerOnlySandbox === true || !capability.supported) throw unsupportedPurchase();
            if (!capability.available) throw Object.assign(new Error('购买暂未开放，已有订单仍可查询。'), { code: 'XPAY_NOT_READY' });
          }
          if (validateFreshCatalog && validateFreshCatalog(currentCatalog) !== true) throw Object.assign(new Error('套餐内容或服务范围已变化，请返回查看套餐并重新确认'), { code: 'XPAY_PAYMENT_CATALOG_CHANGED' });
          assertActive(operationRevision);
        }
        if (!pending) {
          const random = await invoke('getRandomValues', { length: 16 });
          assertActive(operationRevision);
          const key = Array.from(new Uint8Array(random.randomValues)).map(x => x.toString(16).padStart(2, '0')).join('');
          // A reconnected client may have persisted the same account's intent
          // while native randomness was pending. Never overwrite it with a new key.
          pending = wxApi.getStorageSync(storageKey);
          if (pending?.productId !== undefined && pending.productId !== productId) throw new Error('上一笔订单尚未确认，请先核实原套餐');
          if (pending?.orderId) throw new Error('上一笔订单正在确认，请刷新订单记录，勿重复付款');
          if (!pending) { pending = { productId, idempotencyKey: key }; wxApi.setStorageSync(storageKey, pending); }
        }
        assertActive(operationRevision);
        const attemptKey = pending.idempotencyKey;
        const created = await requestAt('/api/mini/payments/orders', { method: 'POST', data: { productId, platform: device.platform, agreed: true, rulesVersion }, idempotencyKey: pending.idempotencyKey }, operationRevision, receipt => {
          if (accountId !== session?.user?.id || typeof receipt?.order?.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(receipt.order.id)) return;
          const current = wxApi.getStorageSync(storageKey);
          if (current?.idempotencyKey === attemptKey && current.productId === productId
            && (!current.orderId || current.orderId === receipt.order.id)) wxApi.setStorageSync(storageKey, { ...current, orderId: receipt.order.id });
        });
        assertActive(operationRevision);
        if (accountChanged) throw identityError();
        if (typeof created?.order?.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(created.order.id)) {
          throw confirmationError('XPAY_PAYMENT_CONFIRMATION_MISMATCH');
        }
        pending = wxApi.getStorageSync(storageKey);
        if (!pending || pending.idempotencyKey !== attemptKey || pending.orderId !== created.order.id) throw new Error('原支付记录已变化，请刷新订单核实，勿重复付款');
        if (created.order.amountFen !== expectedAmountFen || created.order.productId !== expectedProductId
          || (created.order.product && created.order.product.id !== expectedProductId)) {
          throw confirmationError('XPAY_PAYMENT_CONFIRMATION_MISMATCH');
        }
        let clientResult = 'unconfirmed';
        if (created.payment && pending.nativePaymentStarted !== true) {
          let signed;
          try { signed = typeof created.payment.signData === 'string' ? JSON.parse(created.payment.signData) : null; }
          catch { signed = null; }
          if (!signed || Array.isArray(signed) || created.order.status !== 'pending'
            || created.payment.mode !== 'short_series_goods'
            || signed.goodsPrice !== expectedAmountFen || signed.productId !== expectedProductId
            || signed.outTradeNo !== created.order.id || signed.env !== expectedEnv
            || signed.buyQuantity !== 1 || signed.currencyType !== 'CNY'
            || typeof created.payment.paySig !== 'string' || !created.payment.paySig
            || typeof created.payment.signature !== 'string' || !created.payment.signature) {
            throw confirmationError('XPAY_PAYMENT_CONFIRMATION_MISMATCH');
          }
          // Pass the exact server-signed strings. Never rewrite signData/signatures
          // to make a mismatched order fit the locally confirmed amount.
          assertActive(operationRevision);
          wxApi.setStorageSync(storageKey, { ...pending, nativePaymentStarted: true });
          try { await invoke('requestVirtualPayment', created.payment); clientResult = 'returned'; }
          catch { clientResult = 'cancelled_or_unconfirmed'; }
          assertActive(operationRevision);
        }
        // Neither success nor cancel is a payment fact. The backend verifies with WeChat.
        try {
          assertActive(operationRevision);
          const order = await refreshOrderAt(created.order.id, operationRevision);
          return { order, pending: order.status === 'pending', clientResult };
        } catch (error) {
          if (['XPAY_ACCOUNT_CHANGED', 'XPAY_PAGE_INACTIVE'].includes(error.code)) throw error;
          return { order: created.order, pending: true, clientResult, message: '支付结果正在确认，请勿重复付款，可在订单记录中刷新' };
        }
      } finally { paying = false; }
    },
  };
}
module.exports = { createPaymentClient };
