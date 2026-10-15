import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { createPaymentClient } = createRequire(import.meta.url)('../../miniprogram/payments.js');
const confirmedPhoto = { expectedAmountFen: 990, expectedProductId: 'photo10', expectedEnv: 1 };
const signedPhoto = () => ({ mode: 'short_series_goods', paySig: 'server-pay-signature', signature: 'server-user-signature',
  signData: JSON.stringify({ env: 1, goodsPrice: 990, productId: 'photo10', outTradeNo: 'order1', buyQuantity: 1, currencyType: 'CNY' }) });

function setup({ nativeFails = false, serverStatus = 'pending', requestFails = false, cloud = false, loginFailsFirst = false, requestOverride } = {}) {
  const storage = new Map(); const calls = []; let nativeCalls = 0; let loginCalls = 0;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    canIUse: () => true, getDeviceInfo: () => ({ platform: 'android' }),
    login: options => { loginCalls++; if (loginFailsFirst && loginCalls === 1) return options.fail({ errMsg: 'login:fail' }); options.success({ code: 'temporary-code' }); },
    getRandomValues: options => options.success({ randomValues: new Uint8Array(16).fill(4).buffer }),
    requestVirtualPayment: options => { nativeCalls++; nativeFails ? options.fail({ errCode: -1 }) : options.success({}); },
    request: options => {
      calls.push(options);
      if (requestOverride?.(options, calls)) return;
      if (options.url.endsWith('/api/auth/wechat')) return options.success({ statusCode: 200, data: { code: 0, data: { token: 'test-token', user: { id: 'buyer' } } } });
      if (options.url.endsWith('/products')) return apiReply(options, { available: true, ledgerOnlySandbox: true,
        products: [{ id: 'photo10', amountFen: 990 }], rulesVersion: 'sandbox-rules' });
      if (options.method === 'POST') return options.success({ statusCode: 200, data: { code: 0, data: { order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 }, payment: signedPhoto() } } });
      if (requestFails) return options.fail({ errMsg: 'timeout' });
      return options.success({ statusCode: 200, data: { code: 0, data: { id: 'order1', status: serverStatus } } });
    },
  };
  if (cloud) {
    const handler = wx.request;
    wx.cloud = { callContainer: options => new Promise((resolve, reject) => handler({ ...options, url: options.path, success: resolve, fail: reject })) };
    wx.request = () => { throw new Error('Unexpected public fallback'); };
  }
  return { client: createPaymentClient(wx, cloud ? { mode: 'cloud', env: 'test-environment', service: 'payments-test' } : 'https://example.com'), wx, storage, calls, nativeCalls: () => nativeCalls, loginCalls: () => loginCalls };
}
test('native success never locally grants; restart keeps unresolved order without second charge', async () => {
  const f = setup();
  assert.equal((await f.client.buy('photo10', undefined, confirmedPhoto)).pending, true);
  assert.equal(f.nativeCalls(), 1);
  const restarted = createPaymentClient(f.wx, 'https://example.com');
  assert.equal((await restarted.buy('photo10', undefined, confirmedPhoto)).pending, true);
  assert.equal(f.nativeCalls(), 1);
  assert.equal(f.calls.filter(x => x.method === 'POST' && x.url.endsWith('/orders')).length, 1);
});
test('native cancel still queries authoritative payment and clears paid pending state', async () => {
  const f = setup({ nativeFails: true, serverStatus: 'paid' });
  const result = await f.client.buy('photo10', undefined, confirmedPhoto);
  assert.equal(result.order.status, 'paid'); assert.equal(result.pending, false); assert.equal(f.storage.size, 0);
});
test('query timeout preserves pending attempt; client submits no price or credits', async () => {
  const f = setup({ requestFails: true });
  const result = await f.client.buy('photo10', undefined, confirmedPhoto); assert.equal(result.pending, true); assert.equal(f.storage.size, 1);
  const order = f.calls.find(x => x.url.endsWith('/orders'));
  assert.deepEqual(order.data, { productId: 'photo10', platform: 'android', agreed: true, rulesVersion: undefined });
  assert.match(order.header['Idempotency-Key'], /^[a-f0-9]{32}$/);
});
test('unsupported client and duplicate taps cannot start payment', async () => {
  const f = setup(); f.wx.canIUse = () => false;
  await assert.rejects(f.client.buy('photo10', undefined, confirmedPhoto), /不支持/); assert.equal(f.nativeCalls(), 0);
  assert.throws(() => createPaymentClient(f.wx, 'http://example.com'), /HTTPS/);
});

test('cloud transport preserves login, server-owned order, token and idempotency without public requests', async () => {
  const f = setup({ cloud: true, serverStatus: 'paid' });
  const result = await f.client.buy('photo10', 'reviewed-rules', confirmedPhoto);
  assert.equal(result.order.status, 'paid'); assert.equal(f.nativeCalls(), 1);
  assert.ok(f.calls.every(c => c.config.env === 'test-environment' && c.header['X-WX-SERVICE'] === 'payments-test' && c.path.startsWith('/api/')));
  assert.equal(f.calls[0].header.Authorization, undefined);
  const order = f.calls.find(c => c.path.endsWith('/orders'));
  assert.equal(order.header.Authorization, 'Bearer test-token'); assert.match(order.header['Idempotency-Key'], /^[a-f0-9]{32}$/);
  assert.deepEqual(order.data, { productId: 'photo10', platform: 'android', agreed: true, rulesVersion: 'reviewed-rules' });
  assert.equal(f.storage.size, 0);
});

test('cloud timeout keeps pending payment without fallback or second charge; missing target stays closed', async () => {
  const f = setup({ cloud: true, requestFails: true });
  assert.equal((await f.client.buy('photo10', undefined, confirmedPhoto)).pending, true);
  assert.equal(f.storage.size, 1); assert.equal(f.nativeCalls(), 1);
  assert.throws(() => createPaymentClient(f.wx, { mode: 'cloud', env: 'test-environment', service: '' }), /尚未配置/);
  assert.throws(() => createPaymentClient({}, { mode: 'cloud', env: 'test-environment', service: 'payments-test' }), /升级微信/);
});

test('a failed initial login recovers on concurrent refresh requests with one shared login', async () => {
  const f = setup({ loginFailsFirst: true });
  await assert.rejects(f.client.login(), error => error.errMsg === 'login:fail');
  const results = await Promise.all([f.client.products(), f.client.entitlements(), f.client.orders()]);
  assert.equal(results.length, 3); assert.equal(f.loginCalls(), 2); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/api/auth/wechat')).length, 1);
  assert.ok(f.calls.filter(c => !c.url.endsWith('/api/auth/wechat')).every(c => c.header.Authorization === 'Bearer test-token'));
});

test('concurrent cloud queries recover one expired session without public fallback', async () => {
  let authCalls = 0;
  const f = setup({ cloud: true, requestOverride: options => {
    if (options.url.endsWith('/api/auth/wechat')) {
      authCalls++; options.success({ statusCode: 200, data: { code: 0, data: { token: `token${authCalls}`, user: { id: 'buyer' } } } }); return true;
    }
    if (options.header.Authorization === 'Bearer token1') { options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true; }
  } });
  await f.client.login();
  await Promise.all([f.client.entitlements(), f.client.orders(), f.client.refunds()]);
  assert.equal(authCalls, 2); assert.equal(f.loginCalls(), 2); assert.equal(f.nativeCalls(), 0);
  const business = f.calls.filter(c => !c.url.endsWith('/api/auth/wechat'));
  assert.equal(business.length, 6); assert.equal(business.filter(c => c.header.Authorization === 'Bearer token2').length, 3);
  assert.ok(f.calls.every(c => c.config.env === 'test-environment' && c.header['X-WX-SERVICE'] === 'payments-test'));
  assert.ok(f.calls.filter(c => c.url.endsWith('/api/auth/wechat')).every(c => c.header.Authorization === undefined));
});

test('authentication rejection retries only once and a later refresh can recover', async () => {
  let rejecting = true;
  const f = setup({ requestOverride: options => {
    if (!options.url.endsWith('/api/auth/wechat') && rejecting) { options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true; }
  } });
  await f.client.login();
  await assert.rejects(f.client.orders(), error => error.statusCode === 401);
  assert.equal(f.loginCalls(), 2); assert.equal(f.calls.filter(c => c.url.endsWith('/orders')).length, 2);
  rejecting = false;
  await f.client.orders();
  assert.equal(f.loginCalls(), 3); assert.equal(f.nativeCalls(), 0);
});

test('explicit expired-session code recovers but unrelated provider errors do not retry', async () => {
  let attempt = 0;
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/orders') && ++attempt === 1) { options.success({ statusCode: 403, data: { code: 'SESSION_EXPIRED' } }); return true; }
    if (options.url.endsWith('/refunds')) { options.success({ statusCode: 503, data: { code: 'XPAY_UNCONFIRMED' } }); return true; }
  } });
  await f.client.login(); await f.client.orders();
  assert.equal(f.loginCalls(), 2); assert.equal(attempt, 2);
  await assert.rejects(f.client.refunds(), error => error.code === 'XPAY_UNCONFIRMED');
  assert.equal(f.loginCalls(), 2); assert.equal(f.calls.filter(c => c.url.endsWith('/refunds')).length, 1);
});

test('order authentication recovery preserves the same idempotency key and invokes payment once', async () => {
  let attempts = 0;
  const f = setup({ requestOverride: options => {
    if (options.method === 'POST' && options.url.endsWith('/orders') && ++attempts === 1) { options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true; }
  } });
  assert.equal((await f.client.buy('photo10', 'reviewed-rules', confirmedPhoto)).pending, true);
  const orders = f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders'));
  assert.equal(orders.length, 2); assert.equal(f.nativeCalls(), 1); assert.equal(f.loginCalls(), 2);
  assert.equal(orders[0].header['Idempotency-Key'], orders[1].header['Idempotency-Key']); assert.deepEqual(orders[0].data, orders[1].data);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
});

test('an expired session querying a pending order never creates another order or payment', async () => {
  const original = { productId: 'photo10', idempotencyKey: 'original-attempt', orderId: 'order1' };
  let queries = 0;
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/orders/order1') && ++queries === 1) { options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true; }
  } });
  f.storage.set('lyx-payment-pending:buyer', structuredClone(original));
  const result = await f.client.buy('photo10', 'reviewed-rules', confirmedPhoto);
  assert.equal(result.pending, true); assert.equal(queries, 2); assert.equal(f.loginCalls(), 2); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders')).length, 0);
  assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), original);
});

test('an ambiguous order creation failure preserves its key without authentication or payment retry', async () => {
  const f = setup({ requestOverride: options => {
    if (options.method === 'POST' && options.url.endsWith('/orders')) { options.fail({ errMsg: 'request:fail timeout' }); return true; }
  } });
  await assert.rejects(f.client.buy('photo10', 'reviewed-rules', confirmedPhoto), error => error.errMsg.includes('timeout'));
  assert.equal(f.loginCalls(), 1); assert.equal(f.nativeCalls(), 0); assert.equal(f.calls.filter(c => c.url.endsWith('/orders')).length, 1);
  assert.match(f.storage.get('lyx-payment-pending:buyer').idempotencyKey, /^[a-f0-9]{32}$/);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, undefined);
});

test('account change during authentication recovery stops replay and preserves both accounts pending records', async () => {
  let authCalls = 0;
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/api/auth/wechat')) {
      authCalls++; options.success({ statusCode: 200, data: { code: 0, data: { token: `token${authCalls}`, user: { id: authCalls === 1 ? 'buyer' : 'other-buyer' } } } }); return true;
    }
    options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true;
  } });
  const first = { productId: 'photo10', orderId: 'order1', idempotencyKey: 'first-account' };
  const second = { productId: 'photo10', orderId: 'order2', idempotencyKey: 'second-account' };
  f.storage.set('lyx-payment-pending:buyer', structuredClone(first)); f.storage.set('lyx-payment-pending:other-buyer', structuredClone(second));
  await f.client.login();
  await assert.rejects(f.client.refreshOrder('order1'), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  const sent = f.calls.length;
  await assert.rejects(f.client.buy('photo10', undefined, confirmedPhoto), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  await assert.rejects(f.client.orders(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.calls.length, sent); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/orders/order1')).length, 1);
  assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), first); assert.deepEqual(f.storage.get('lyx-payment-pending:other-buyer'), second);
});

test('account change after payment is surfaced instead of returning the old account order', async () => {
  let authCalls = 0;
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/api/auth/wechat')) {
      authCalls++; options.success({ statusCode: 200, data: { code: 0, data: { token: `token${authCalls}`, user: { id: authCalls === 1 ? 'buyer' : 'other-buyer' } } } }); return true;
    }
    if (options.url.endsWith('/orders/order1')) { options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true; }
  } });
  await assert.rejects(f.client.buy('photo10', undefined, confirmedPhoto), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.nativeCalls(), 1); assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders')).length, 1);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1'); assert.equal(f.storage.has('lyx-payment-pending:other-buyer'), false);
});

function paymentPage(fixture) {
  let page;
  fixture.wx.getPrivacySetting ||= options => options.success({ needAuthorization: false });
  fixture.wx.requirePrivacyAuthorize ||= options => options.success({});
  const privacyModule = { exports: {} };
  runInNewContext(readFileSync(new URL('../../miniprogram/privacy-consent.js', import.meta.url), 'utf8'), { module: privacyModule, wx: fixture.wx });
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/payments/index.js', import.meta.url), 'utf8'), {
    require: name => { if (name === '../../privacy-consent') return privacyModule.exports; assert.equal(name, '../../payments'); return { createPaymentClient }; },
    Page: definition => { page = definition; }, wx: fixture.wx,
    getApp: () => ({ globalData: { apiTransport: 'https://example.com' } }),
  });
  page.data = structuredClone(page.data);
  page.setData = update => Object.assign(page.data, update);
  // Direct-handler fixtures begin on an admitted, visible page. Lifecycle tests
  // call onLoad(), which resets admission and runs the real privacy gate.
  page.visible = true; page.revision = 0; page.data.connected = true;
  return page;
}

const flushPage = () => new Promise(resolve => setImmediate(resolve));
const apiReply = (request, data) => request.success({ statusCode: 200, data: { code: 0, data } });
function paymentReadFixture(intercept) {
  const f = setup({ requestOverride: request => {
    if (intercept?.(request)) return true;
    let data;
    if (request.url.endsWith('/products')) data = { available: true, ledgerOnlySandbox: true, rulesVersion: 'sandbox-rules',
      products: [{ id: 'photo10', name: '图片包', amountFen: 990, days: 365, components: [{ kind: 'photo', quantity: 10 }] }] };
    else if (request.url.endsWith('/entitlements')) data = { available: { photo: 3, video: 0 }, buckets: [] };
    else if (request.url.endsWith('/orders') && request.method !== 'POST') data = [{ id: 'owned-order', status: 'paid', platform: 'android', amountFen: 990, product: { name: '图片包' }, createdAt: 1 }];
    else if (request.url.endsWith('/refunds')) data = [{ id: 'owned-refund', orderId: 'owned-order', amountFen: 990, status: 'requested' }];
    if (data === undefined) return false;
    apiReply(request, data); return true;
  } });
  f.wx.showModal = options => options.success?.({ confirm: false });
  f.wx.showToast = () => {};
  return f;
}

test('payments privacy admission blocks login and all account paths until explicit acceptance; decline permits retry', async () => {
  const f = paymentReadFixture(); let privacyCalls = 0;
  f.wx.getPrivacySetting = options => options.success({ needAuthorization: true, privacyContractName: '平台隐私指引' });
  f.wx.requirePrivacyAuthorize = options => { privacyCalls++; options.success({}); };
  const page = paymentPage(f); const loading = page.onLoad(); page.onShow(); await flushPage();
  assert.equal(page.data.privacyVisible, true); assert.equal(page.data.connected, false);
  await page.refresh(); await page.buy({ currentTarget: { dataset: { id: 'photo10' } } });
  await page.queryOrder({ currentTarget: { dataset: { id: 'owned-order' } } });
  await page.refundOrder({ currentTarget: { dataset: { id: 'owned-order' } } });
  await page.confirmSandboxRefund({ currentTarget: { dataset: { id: 'owned-refund' } } });
  assert.equal(f.loginCalls(), 0); assert.equal(f.calls.length, 0); assert.equal(privacyCalls, 0);
  page.declineNativePrivacy(); await loading;
  assert.equal(page.data.connected, false); assert.equal(page.data.connecting, false); assert.equal(f.calls.length, 0);
  const retry = page.connect(); await flushPage();
  await page.agreeNativePrivacy(); await retry;
  assert.equal(privacyCalls, 1); assert.equal(f.loginCalls(), 1); assert.equal(page.data.connected, true);
  assert.equal(page.data.photo, 3); assert.equal(page.data.orders[0].id, 'owned-order'); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(call => call.method === 'POST' && !call.url.endsWith('/api/auth/wechat')).length, 0);
  const template = readFileSync(new URL('../../miniprogram/pages/payments/index.wxml', import.meta.url), 'utf8');
  assert.match(template, /privacy-consent.*privacyDescription/); assert.match(template, /bindtap="connect"/);
  assert.match(page.data.privacyDescription, /订单及退款记录/);
});

test('late privacy setting, native admission and agreement cannot log in after payments page hides', async t => {
  for (const phase of ['setting', 'already-authorized', 'agreement']) await t.test(phase, async () => {
    const f = paymentReadFixture(); let held;
    f.wx.getPrivacySetting = options => phase === 'setting' ? (held = options) : options.success({ needAuthorization: phase === 'agreement' });
    f.wx.requirePrivacyAuthorize = options => { held = options; };
    const page = paymentPage(f); const loading = page.onLoad(); await flushPage();
    let agreeing;
    if (phase === 'agreement') { agreeing = page.agreeNativePrivacy(); await flushPage(); }
    assert.ok(held); page.onHide(); page.onShow();
    held.success(phase === 'setting' ? { needAuthorization: false } : {});
    await agreeing; await loading;
    assert.equal(f.loginCalls(), 0); assert.equal(f.calls.length, 0); assert.equal(page.data.connected, false);
    assert.equal(page.data.privacyVisible, false); assert.equal(page.data.connecting, false);
  });
});

test('late login from a hidden payments page cannot read or replace a newly connected account view', async () => {
  let held, hold = true;
  const f = paymentReadFixture(request => {
    if (hold && request.url.endsWith('/api/auth/wechat')) { held = request; return true; }
    return false;
  });
  const page = paymentPage(f); const loading = page.onLoad(); await flushPage(); assert.ok(held);
  page.onHide(); page.onShow(); hold = false; await page.connect();
  const reads = f.calls.filter(call => call.url.endsWith('/orders')).length;
  apiReply(held, { token: 'old-token', user: { id: 'old-buyer' } }); await loading;
  assert.equal(page.data.connected, true); assert.equal(page.data.photo, 3); assert.equal(page.data.connecting, false);
  assert.equal(f.calls.filter(call => call.url.endsWith('/orders')).length, reads);
  assert.equal(page.client.currentAccountId(), 'buyer');
});

test('late account lists and refunds cannot repaint or unlock a newer payments refresh', async t => {
  for (const phase of ['entitlements', 'refunds']) await t.test(phase, async () => {
    let hold = false, held;
    const f = paymentReadFixture(request => {
      if (hold && request.url.endsWith(`/${phase}`)) { held = request; return true; }
      return false;
    });
    const page = paymentPage(f); await page.onLoad(); hold = true;
    const oldRefresh = page.refresh(); await flushPage(); assert.ok(held);
    const oldReply = held; page.onHide(); page.onShow(); hold = false; await page.connect();
    hold = true; const newRefresh = page.refresh(); await flushPage(); assert.notEqual(held, oldReply);
    apiReply(oldReply, phase === 'entitlements' ? { available: { photo: 999, video: 999 }, buckets: [] }
      : [{ id: 'old-refund', orderId: 'old-order', amountFen: 999, status: 'succeeded' }]);
    await oldRefresh;
    assert.equal(page.data.refreshing, true); assert.equal(page.data.photo, 3); assert.equal(page.data.refunds[0].id, 'owned-refund');
    apiReply(held, phase === 'entitlements' ? { available: { photo: 4, video: 0 }, buckets: [] } : []);
    hold = false; await newRefresh;
    assert.equal(page.data.refreshing, false); assert.equal(page.refreshTask, null);
    assert.equal(page.data.photo, phase === 'entitlements' ? 4 : 3);
  });
});

test('late purchase and refund confirmations after hiding cannot submit account mutations', async t => {
  for (const method of ['buy', 'refundOrder', 'confirmSandboxRefund']) await t.test(method, async () => {
    const f = paymentReadFixture(); const page = paymentPage(f); await page.onLoad();
    page.data.agreement = true; let modal;
    f.wx.showModal = options => { modal = options; };
    const id = method === 'buy' ? 'photo10' : method === 'refundOrder' ? 'owned-order' : 'owned-refund';
    const operation = page[method]({ currentTarget: { dataset: { id } } }); assert.ok(modal);
    const before = f.calls.length; page.onHide(); page.onShow(); modal.success({ confirm: true }); await operation;
    assert.equal(f.calls.length, before); assert.equal(f.nativeCalls(), 0); assert.equal(page.data.connected, false);
    assert.equal(page.data.orders.length, 0); assert.equal(page.data.refunds.length, 0); assert.equal(page.data.loading, false);
  });
});

test('refund double taps share one confirmation and a failed dialog releases the page lock', async () => {
  const f = paymentReadFixture(); const page = paymentPage(f); await page.onLoad(); let modal, count = 0;
  f.wx.showModal = options => { modal = options; count++; };
  const event = { currentTarget: { dataset: { id: 'owned-order' } } };
  const operation = page.refundOrder(event); await page.refundOrder(event);
  assert.equal(count, 1); assert.equal(page.data.loading, true);
  modal.fail({ errMsg: 'showModal:fail' }); await operation;
  assert.equal(page.data.loading, false); assert.equal(f.calls.filter(call => call.url.endsWith('/refund')).length, 0);
});

test('payment completion while hidden preserves pending reconciliation without reopening account lists or success UI', async () => {
  const f = paymentReadFixture(); const page = paymentPage(f); await page.onLoad(); page.data.agreement = true;
  let native; const modals = [];
  f.wx.showModal = options => { modals.push(options); options.success?.({ confirm: true }); };
  f.wx.requestVirtualPayment = options => { native = options; };
  const buying = page.buy({ currentTarget: { dataset: { id: 'photo10' } } }); await flushPage(); assert.ok(native);
  const lists = f.calls.filter(call => ['/products', '/entitlements', '/orders', '/refunds'].some(path => call.method !== 'POST' && call.url.endsWith(path))).length;
  page.onHide(); native.success({}); await buying;
  assert.equal(modals.length, 1); assert.equal(page.data.connected, false); assert.equal(page.data.orders.length, 0);
  assert.equal(f.calls.filter(call => ['/products', '/entitlements', '/orders', '/refunds'].some(path => call.method !== 'POST' && call.url.endsWith(path))).length, lists);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 1);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
});

test('sandbox page labels test rights and requires explicit owned refund confirmation', async () => {
  const modals = []; let confirmations = 0; let refundStatus = 'requested';
  const f = setup({ requestOverride: options => {
    let data;
    if (options.url.endsWith('/products')) data = { available: true, ledgerOnlySandbox: true, products: [], rulesVersion: 'sandbox-rules' };
    if (options.url.endsWith('/entitlements')) data = { available: { photo: 0, video: 0 }, buckets: [] };
    if (options.url.endsWith('/orders')) data = [];
    if (options.url.endsWith('/refunds')) data = [{ id: 'refund1', orderId: 'order1', amountFen: 990, status: refundStatus }];
    if (options.url.endsWith('/sandbox/refunds/refund1/confirm')) {
      assert.equal(options.method, 'POST'); assert.deepEqual(options.data, { confirm: true });
      confirmations++; refundStatus = 'processing'; data = { status: refundStatus };
    }
    if (data) { options.success({ statusCode: 200, data: { code: 0, data } }); return true; }
  } });
  f.wx.showModal = options => { modals.push(options); options.success?.({ confirm: true }); };
  const page = paymentPage(f); await page.onLoad();
  assert.equal(page.data.ledgerOnlySandbox, true); assert.equal(page.data.available, true);
  assert.match(page.data.notice, /可能实际扣款/); assert.match(page.data.notice, /以微信收银台为准/); assert.match(page.data.notice, /图片创作尚未开放/);
  assert.equal(confirmations, 0); assert.equal(f.nativeCalls(), 0);
  await page.confirmSandboxRefund({ currentTarget: { dataset: { id: 'another-refund' } } });
  assert.equal(modals.length, 0);
  await page.confirmSandboxRefund({ currentTarget: { dataset: { id: 'refund1' } } });
  assert.equal(modals[0].title, '确认沙箱退款'); assert.equal(confirmations, 1);
  assert.match(modals[0].content, /¥9\.90/); assert.match(modals[0].content, /原路退款结果以渠道确认为准/);
  assert.equal(page.data.refunds[0].canConfirm, false); assert.match(page.data.refunds[0].statusText, /尚未确认到账/);
  await page.confirmSandboxRefund({ currentTarget: { dataset: { id: 'refund1' } } });
  assert.equal(confirmations, 1); assert.equal(f.nativeCalls(), 0);
});

test('formal closed sales still show owned refund amounts and progress without any sandbox confirmation',async()=>{
  const statuses=['requested','processing','succeeded','rejected','abnormal'];
  const f=setup({requestOverride:options=>{
    let data;
    if(options.url.endsWith('/products'))data={available:false,ledgerOnlySandbox:false,products:[],rulesVersion:'formal-rules'};
    else if(options.url.endsWith('/entitlements'))data={available:{photo:0,video:0},buckets:[]};
    else if(options.url.endsWith('/orders'))data=[];
    else if(options.url.endsWith('/refunds'))data=statuses.map((status,index)=>({id:`refund${index}`,orderId:`order${index}`,amountFen:990-index,status}));
    if(data){options.success({statusCode:200,data:{code:0,data}});return true;}
  }});
  f.wx.showModal=()=>assert.fail('formal refunds never open sandbox confirmation');
  const page=paymentPage(f);await page.onLoad();
  assert.equal(page.data.available,false);assert.equal(page.data.refunds.length,5);
  assert.equal(page.data.refunds[0].price,'9.90');assert.equal(page.data.refunds[0].statusText,'待人工审核');
  assert.match(page.data.refunds[1].statusText,/尚未确认到账/);assert.match(page.data.refunds[3].statusText,/冻结权益已恢复/);
  assert.match(page.data.refunds[4].statusText,/权益保持冻结/);assert.ok(page.data.refunds.every(row=>row.canConfirm===false));
  // Even a local flag on a record cannot make env0 invoke the sandbox endpoint.
  page.data.refunds[0].canConfirm=true;await page.confirmSandboxRefund({currentTarget:{dataset:{id:'refund0'}}});
  assert.equal(f.calls.filter(call=>call.method==='POST'&&!call.url.endsWith('/api/auth/wechat')).length,0);assert.equal(f.nativeCalls(),0);
  const template=readFileSync(new URL('../../miniprogram/pages/payments/index.wxml',import.meta.url),'utf8');
  assert.doesNotMatch(template,/wx:if="\{\{ledgerOnlySandbox\}\}"[^>]*wx:for="\{\{refunds\}\}"/);
});

test('the native page pull-down refresh recovers initial login failure without buying', async () => {
  let stopped = 0;
  const f = setup({ loginFailsFirst: true, requestOverride: options => {
    let data;
    if (options.url.endsWith('/products')) data = { available: false, rulesVersion: 'reviewed-rules', products: [] };
    if (options.url.endsWith('/entitlements')) data = { available: { photo: 3, video: 1 }, buckets: [] };
    if (options.url.endsWith('/orders')) data = [];
    if (options.url.endsWith('/refunds')) data = [];
    if (data) { options.success({ statusCode: 200, data: { code: 0, data } }); return true; }
  } });
  f.wx.stopPullDownRefresh = () => { stopped++; };
  const page = paymentPage(f);
  await page.onLoad();
  assert.equal(f.loginCalls(), 1); assert.equal(page.data.available, false);
  await page.onPullDownRefresh();
  assert.equal(stopped, 1); assert.equal(f.loginCalls(), 2); assert.equal(page.data.photo, 3); assert.equal(page.data.video, 1);
  assert.equal(page.data.notice, '购买暂未开放，已有订单仍可查询。'); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders')).length, 0);
});

test('the native page clears old account data when recovery detects another account', async () => {
  let authCalls = 0;
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/api/auth/wechat')) {
      authCalls++; options.success({ statusCode: 200, data: { code: 0, data: { token: `token${authCalls}`, user: { id: authCalls === 1 ? 'buyer' : 'other-buyer' } } } }); return true;
    }
    options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } }); return true;
  } });
  const page = paymentPage(f);
  page.client = f.client;
  await page.client.login();
  Object.assign(page.data, { products: [{ id: 'photo10' }], orders: [{ id: 'order1', platform: 'android' }], buckets: [{ id: 'bucket1' }], photo: 10, video: 5, available: true, agreement: true });
  await page.refresh();
  assert.equal(page.data.available, false); assert.equal(page.data.agreement, false); assert.equal(page.data.photo, 0); assert.equal(page.data.video, 0);
  assert.equal(page.data.orders.length, 0); assert.equal(page.data.products.length, 0); assert.equal(page.data.buckets.length, 0);
  assert.match(page.data.notice, /微信账号已变化/); assert.equal(f.nativeCalls(), 0);
  const sent = f.calls.length;
  await page.refundOrder({ currentTarget: { dataset: { id: 'order1' } } });
  assert.equal(f.calls.length, sent);
});

function reviewedPageProduct() {
  return { id: 'photo10', name: '图片包', type: 'pack', amountFen: 990, days: 365,
    components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] };
}
function reviewedPageScope() {
  const ids = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
  return { settings: { generationEnabled: true }, miniProgramCreation: { available: true,
    jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: ids },
    photoEffects: ids.map(id => ({ id, enabled: true })) };
}
function pageWithRefreshFailure(failure) {
  let authCalls = 0, submitted = false; const modals = [];
  const order = { id: 'order1', status: 'paid', platform: 'android', productId: 'photo10', product: { id: 'photo10', name: '图片包' }, amountFen: 990, createdAt: 1 };
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/api/auth/wechat')) {
      authCalls++; options.success({ statusCode: 200, data: { code: 0, data: { token: `token${authCalls}`, user: { id: submitted && failure === 'account-change' ? 'other-buyer' : 'buyer' } } } }); return true;
    }
    if (options.url.endsWith('/products')) {
      if (submitted && failure === 'account-change') options.success({ statusCode: 401, data: { code: 'AUTH_REQUIRED' } });
      else if (submitted && failure === 'timeout') options.fail({ errMsg: 'request:fail timeout', message: '网络结果尚未确认' });
      else options.success({ statusCode: 200, data: { code: 0, data: { available: true, rulesVersion: 'mini-pay-v1-20260927', products: [reviewedPageProduct()],
        purchaseProfile: 'android-only-v1', supportedPlatforms: ['android'] } } });
      return true;
    }
    if (options.url.endsWith('/api/catalog')) { apiReply(options, reviewedPageScope()); return true; }
    let data;
    if (options.url.endsWith('/orders/order1/refund')) { submitted = true; data = { amountFen: 990 }; }
    else if (options.url.endsWith('/orders/order1')) data = order;
    else if (options.url.endsWith('/orders')) { if (options.method === 'POST') submitted = true; data = options.method === 'POST' ? { order, payment: null } : [order]; }
    else if (options.url.endsWith('/entitlements')) data = { available: { photo: 10, video: 0 }, buckets: [] };
    else if (options.url.endsWith('/refunds')) data = [];
    if (data) { options.success({ statusCode: 200, data: { code: 0, data } }); return true; }
  } });
  f.wx.showModal = options => { modals.push(options); options.success?.({ confirm: true }); };
  const page = paymentPage(f);
  page.client = f.client;
  Object.assign(page.data, { agreement: true, available: true, products: [reviewedPageProduct()], orders: [order], photo: 10, rulesVersion: 'mini-pay-v1-20260927' });
  return { f, page, modals };
}

for (const failure of ['account-change', 'timeout']) {
  test(`the native page does not announce old purchase success after ${failure} during final refresh`, async () => {
    const { f, page, modals } = pageWithRefreshFailure(failure);
    await page.buy({ currentTarget: { dataset: { id: 'photo10' } } });
    assert.equal(modals.length, 1); assert.equal(modals[0].title, '确认支付'); assert.equal(page.data.available, false); assert.equal(page.data.loading, false);
    assert.equal(f.nativeCalls(), 0); assert.equal(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/orders')).length, 1);
    if (failure === 'account-change') { assert.equal(page.data.orders.length, 0); assert.equal(page.data.photo, 0); assert.match(page.data.notice, /微信账号已变化/); }
    else { assert.equal(f.loginCalls(), 2); assert.match(page.data.notice, /尚未确认/); }
  });
}

test('the native page does not show the previous account refund amount after final refresh detects account change', async () => {
  const { f, page, modals } = pageWithRefreshFailure('account-change');
  await f.client.login();
  await page.refundOrder({ currentTarget: { dataset: { id: 'order1' } } });
  assert.equal(modals.length, 1); assert.equal(modals[0].title, '申请未使用部分退款');
  assert.equal(page.data.orders.length, 0); assert.equal(page.data.photo, 0); assert.equal(page.data.available, false);
  assert.match(page.data.notice, /微信账号已变化/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/orders/order1/refund')).length, 1); assert.equal(f.nativeCalls(), 0);
});

test('the native page announces confirmed purchase after the same account refresh succeeds', async () => {
  const { f, page, modals } = pageWithRefreshFailure();
  await page.buy({ currentTarget: { dataset: { id: 'photo10' } } });
  assert.equal(modals.length, 2); assert.equal(modals[0].title, '确认支付'); assert.equal(modals[1].title, '购买成功');
  assert.equal(page.data.photo, 10); assert.equal(page.data.orders[0].id, 'order1'); assert.equal(page.data.loading, false);
  assert.equal(f.loginCalls(), 2); assert.equal(f.nativeCalls(), 0);
});

function sandboxPurchasePage(f) {
  const page = paymentPage(f);
  page.client = f.client;
  Object.assign(page.data, { available: true, agreement: true, ledgerOnlySandbox: true,
    products: [{ id: 'photo10', amountFen: 990 }], orders: [{ id: 'order1', status: 'pending' }], rulesVersion: 'sandbox-rules' });
  page.refresh = async () => true;
  return page;
}
const photoBuyEvent = { currentTarget: { dataset: { id: 'photo10' } } };

test('cancelling the sandbox amount warning never calls buy or clears an unresolved payment', async () => {
  const f = setup(); const modals = []; let buys = 0;
  const pending = { productId: 'photo10', idempotencyKey: 'original-key', orderId: 'order1' };
  f.storage.set('lyx-payment-pending:buyer', structuredClone(pending));
  f.wx.showModal = options => { modals.push(options); };
  const page = sandboxPurchasePage(f);
  page.client = { ...f.client, buy: async (...args) => { buys++; return f.client.buy(...args); } };
  const operation = page.buy(photoBuyEvent);
  assert.equal(page.data.loading, true);
  await page.buy(photoBuyEvent); assert.equal(modals.length, 1);
  assert.match(modals[0].content, /¥9\.90/); assert.match(modals[0].content, /可能实际扣款/);
  assert.match(modals[0].content, /以微信收银台为准/); assert.match(modals[0].content, /图片创作尚未开放/);
  modals[0].success({ confirm: false }); await operation;
  assert.equal(buys, 0); assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls(), 0);
  assert.equal(page.data.loading, false); assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), pending);
});

test('confirming the sandbox amount warning calls buy once and keeps loading across the confirmation', async () => {
  const f = setup(); const modals = []; let buys = 0;
  f.wx.showModal = options => { modals.push(options); };
  const page = sandboxPurchasePage(f);
  page.client = { ...f.client, buy: async (...args) => { buys++; assert.equal(page.data.loading, true); return f.client.buy(...args); } };
  const operation = page.buy(photoBuyEvent);
  await page.buy(photoBuyEvent); assert.equal(modals.length, 1); assert.equal(buys, 0);
  modals[0].success({ confirm: true }); await operation;
  assert.equal(buys, 1); assert.equal(f.nativeCalls(), 1); assert.equal(page.data.loading, false);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 1);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
  assert.equal(modals[1].title, '订单正在确认');
});

test('amount confirmation preserves pending-order recovery without a second charge or order', async () => {
  const f = setup(); const pending = { productId: 'photo10', idempotencyKey: 'original-key', orderId: 'order1' };
  f.storage.set('lyx-payment-pending:buyer', structuredClone(pending));
  f.wx.showModal = options => options.success?.({ confirm: true });
  const page = sandboxPurchasePage(f); await page.buy(photoBuyEvent);
  assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/orders/order1')).length, 1);
  assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), pending);
});

test('a failed confirmation dialog releases loading and never invokes payment', async () => {
  const f = setup(); f.wx.showModal = options => options.fail({ errMsg: 'showModal:fail' });
  const page = sandboxPurchasePage(f); await page.buy(photoBuyEvent);
  assert.equal(page.data.loading, false); assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls(), 0);
});

test('sandbox UI does not guarantee that payment or refund bypasses real funds', () => {
  const source = ['index.js', 'index.wxml'].map(name => readFileSync(
    new URL(`../../miniprogram/pages/payments/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /不扣真实资金|不退还真实资金|不涉及真实资金|只处理测试账目|不代表正式购买/);
  assert.match(source, /沙箱联调可能实际扣款，以微信收银台为准；图片创作尚未开放/);
  assert.match(source, /原路退款结果以渠道确认为准/);
});

for (const [before, after, expectedTitle] of [
  ['closed', 'closed', '订单已关闭'],
  ['pending', 'paid', '沙箱测试支付成功'],
  ['paid', 'refunded', '订单已退款'],
  ['paid', 'refund_pending', '退款处理中'],
]) {
  test(`payment page reports refreshed ${after} instead of the older ${before} response`, async () => {
    const modals = [];
    const f = setup({ serverStatus: before, requestOverride: options => {
      let data;
      if (options.url.endsWith('/products')) data = { available: true, ledgerOnlySandbox: true, products: [reviewedPageProduct()], rulesVersion: 'sandbox-rules' };
      else if (options.url.endsWith('/entitlements')) data = { available: { photo: after === 'paid' ? 10 : 0, video: 0 }, buckets: [] };
      else if (options.url.endsWith('/orders') && options.method === 'GET') data = [{ id: 'order1', status: after, product: { name: '图片包' }, amountFen: 990, createdAt: 1 }];
      else if (options.url.endsWith('/refunds')) data = [];
      if (data) { options.success({ statusCode: 200, data: { code: 0, data } }); return true; }
    } });
    f.wx.showModal = options => { modals.push(options); options.success?.({ confirm: true }); };
    const page = paymentPage(f); page.client = f.client;
    Object.assign(page.data, { available: true, agreement: true, ledgerOnlySandbox: true,
      products: [reviewedPageProduct()], rulesVersion: 'sandbox-rules' });
    await page.buy(photoBuyEvent);
    assert.equal(modals.length, 2); assert.equal(modals[1].title, expectedTitle);
    assert.equal(page.data.orders[0].status, after); assert.equal(page.data.loading, false);
    if (after === 'closed') {
      assert.match(modals[1].content, /渠道确认该订单已关闭/);
      assert.match(modals[1].content, /核对微信支付记录/);
      assert.doesNotMatch(modals[1].content, /未扣款|没有扣款|无需核对|无需对账/);
    }
    if (after === 'refunded') assert.match(modals[1].content, /核对渠道退款记录/);
  });
}

test('a missing refreshed order never announces success from the old paid response or a different order', async () => {
  const { page, modals } = pageWithRefreshFailure();
  page.refresh = async () => { page.setData({ orders: [{ id: 'different-order', status: 'paid' }] }); return true; };
  await page.buy(photoBuyEvent);
  assert.equal(modals.length, 2); assert.equal(modals[1].title, '订单状态待核实');
  assert.doesNotMatch(modals[1].content, /已到账|支付成功|购买成功/);
  assert.equal(page.data.loading, false);
});

test('unconfirmed amount or environment cannot create a new order or invoke native payment', async () => {
  for (const confirmation of [undefined, {}, { ...confirmedPhoto, expectedAmountFen: 0 },
    { ...confirmedPhoto, expectedProductId: 'video5' }, { ...confirmedPhoto, expectedEnv: undefined }]) {
    const f = setup();
    await assert.rejects(f.client.buy('photo10', 'reviewed-rules', confirmation), { code: 'XPAY_PAYMENT_CONFIRMATION_REQUIRED' });
    assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
  }
});

test('990-fen confirmation refuses changed server order and signature fields while retaining the original pending order', async t => {
  const mutations = [
    ['price rises to 1990', (order, signed) => { order.amountFen = 1990; signed.goodsPrice = 1990; }],
    ['another product', (order, signed) => { order.productId = 'video5'; signed.productId = 'video5'; }],
    ['nested order product differs', order => { order.product = { id: 'video5' }; }],
    ['signed amount differs', (_order, signed) => { signed.goodsPrice = 1990; }],
    ['signed amount has wrong type', (_order, signed) => { signed.goodsPrice = '990'; }],
    ['signed product differs', (_order, signed) => { signed.productId = 'video5'; }],
    ['signed environment is production', (_order, signed) => { signed.env = 0; }],
    ['signed environment has wrong type', (_order, signed) => { signed.env = '1'; }],
    ['signed order differs', (_order, signed) => { signed.outTradeNo = 'different-order'; }],
    ['signed quantity differs', (_order, signed) => { signed.buyQuantity = 2; }],
    ['signed currency differs', (_order, signed) => { signed.currencyType = 'USD'; }],
    ['already-paid order cannot invoke native', order => { order.status = 'paid'; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const order = { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 };
    const payment = signedPhoto(); const signed = JSON.parse(payment.signData);
    mutate(order, signed); payment.signData = JSON.stringify(signed);
    const f = setup({ requestOverride: options => {
      if (options.method !== 'POST' || !options.url.endsWith('/orders')) return false;
      options.success({ statusCode: 200, data: { code: 0, data: { order, payment } } }); return true;
    } });
    await assert.rejects(f.client.buy('photo10', 'reviewed-rules', confirmedPhoto), { code: 'XPAY_PAYMENT_CONFIRMATION_MISMATCH' });
    assert.equal(f.nativeCalls(), 0);
    assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
    const request = f.calls.find(call => call.url.endsWith('/orders'));
    assert.deepEqual(request.data, { productId: 'photo10', platform: 'android', agreed: true, rulesVersion: 'reviewed-rules' });
  });
});

test('malformed signed data or missing signatures never reach the native cashier', async t => {
  for (const mutation of [{ signData: '{broken' }, { signData: null }, { signData: '[]' },
    { paySig: '' }, { signature: '' }, { mode: 'different_mode' }]) await t.test(JSON.stringify(mutation), async () => {
    const f = setup({ requestOverride: options => {
      if (options.method !== 'POST' || !options.url.endsWith('/orders')) return false;
      options.success({ statusCode: 200, data: { code: 0, data: {
        order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 }, payment: { ...signedPhoto(), ...mutation },
      } } }); return true;
    } });
    await assert.rejects(f.client.buy('photo10', 'reviewed-rules', confirmedPhoto), { code: 'XPAY_PAYMENT_CONFIRMATION_MISMATCH' });
    assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
  });
});

test('matching confirmed payment preserves exact server signData whitespace and both signatures', async () => {
  const payment = { ...signedPhoto(), signData: JSON.stringify(JSON.parse(signedPhoto().signData), null, 2) };
  const f = setup({ requestOverride: options => {
    if (options.method !== 'POST' || !options.url.endsWith('/orders')) return false;
    options.success({ statusCode: 200, data: { code: 0, data: {
      order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 }, payment,
    } } }); return true;
  } });
  let native;
  f.wx.requestVirtualPayment = options => { native = options; options.success({}); };
  await f.client.buy('photo10', 'reviewed-rules', confirmedPhoto);
  assert.equal(native.signData, payment.signData); assert.equal(native.paySig, payment.paySig); assert.equal(native.signature, payment.signature);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
});

test('catalog mutation while the amount modal is open cannot change the frozen confirmation', async () => {
  const f = setup(); const modals = []; let received;
  f.wx.showModal = options => { modals.push(options); };
  const page = sandboxPurchasePage(f);
  page.client = { ...f.client, buy: async (...args) => { received = args; return f.client.buy(...args); } };
  const operation = page.buy(photoBuyEvent);
  page.data.products[0].amountFen = 1990; page.data.products[0].id = 'video5'; page.data.ledgerOnlySandbox = false;
  page.data.rulesVersion = 'new-rules'; modals[0].success({ confirm: true }); await operation;
  assert.equal(received[0], 'photo10'); assert.equal(received[1], 'sandbox-rules');
  assert.deepEqual(JSON.parse(JSON.stringify(received[2])), confirmedPhoto);
  assert.equal(f.nativeCalls(), 1);
});

test('a 990-fen page confirmation with a later 1990-fen server order stops before native and keeps the recovery key', async () => {
  const f = setup({ requestOverride: options => {
    if (options.method !== 'POST' || !options.url.endsWith('/orders')) return false;
    const payment = signedPhoto(); payment.signData = JSON.stringify({ ...JSON.parse(payment.signData), goodsPrice: 1990 });
    options.success({ statusCode: 200, data: { code: 0, data: {
      order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 1990 }, payment,
    } } }); return true;
  } });
  f.wx.showModal = options => options.success?.({ confirm: true });
  const page = sandboxPurchasePage(f); await page.buy(photoBuyEvent);
  assert.equal(f.nativeCalls(), 0); assert.match(page.data.notice, /与确认内容不符/);
  assert.equal(page.data.loading, false); assert.equal(page.data.available, false);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').orderId, 'order1');
});

const formalCatalog = () => ({ available: true, ledgerOnlySandbox: false, purchaseProfile: 'android-only-v1',
  supportedPlatforms: ['android'], products: [{ id: 'photo10', name: '图片包', amountFen: 990, days: 365,
    components: [{ kind: 'photo', quantity: 10 }] }], rulesVersion: 'formal-rules' });

test('formal native purchase blocks iOS, Windows and unknown devices before login/order/key/native without losing prior attempts', async () => {
  for (const platform of ['ios', 'windows', 'ohos', 'devtools', undefined, null]) {
    const f = setup(); f.wx.getDeviceInfo = () => ({ platform });
    const pending = { orderId: 'prior-order', idempotencyKey: 'preserved-key', productId: 'photo10' };
    f.storage.set('lyx-payment-pending:buyer', pending);
    await assert.rejects(f.client.buy('photo10', 'formal-rules', { ...confirmedPhoto, expectedEnv: 0 }));
    assert.equal(f.nativeCalls(), 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), pending);
    // The same client still authenticates for an explicit original-order GET.
    await f.client.refreshOrder('prior-order');
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 0);
  }
});

test('formal purchase requires the fresh exact server profile and cannot turn a stale or expanded catalog into a new payment', async () => {
  for (const catalog of [{}, { ...formalCatalog(), purchaseProfile: undefined }, { ...formalCatalog(), purchaseProfile: 'all-platforms' },
    { ...formalCatalog(), supportedPlatforms: ['android', 'ios'] }, { ...formalCatalog(), supportedPlatforms: ['ios'] },
    { ...formalCatalog(), available: false }, { ...formalCatalog(), ledgerOnlySandbox: true }]) {
    const f = setup({ requestOverride: options => {
      if (!options.url.endsWith('/products')) return false;
      options.success({ statusCode: 200, data: { code: 0, data: catalog } }); return true;
    } });
    await assert.rejects(f.client.buy('photo10', 'formal-rules', { ...confirmedPhoto, expectedEnv: 0, purchaseProfile: 'android-only-v1' }));
    assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.has('lyx-payment-pending:buyer'), false);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 0);
  }
  const f = setup({ serverStatus: 'paid', requestOverride: options => {
    let data;
    if (options.url.endsWith('/products')) data = formalCatalog();
    if (options.url.endsWith('/orders') && options.method === 'POST') {
      const payment = signedPhoto(); payment.signData = JSON.stringify({ ...JSON.parse(payment.signData), env: 0 });
      data = { order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 }, payment };
    }
    if (!data) return false; options.success({ statusCode: 200, data: { code: 0, data } }); return true;
  } });
  await f.client.buy('photo10', 'formal-rules', { ...confirmedPhoto, expectedEnv: 0 });
  assert.equal(f.nativeCalls(), 1);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 1);
});

test('unsupported formal devices display owned rights/orders/refunds but hide the new-purchase catalog and rules', async () => {
  for (const platform of ['ios', 'windows']) {
    const f = setup({ requestOverride: options => {
      let data;
      if (options.url.endsWith('/products')) data = formalCatalog();
      else if (options.url.endsWith('/entitlements')) data = { available: { photo: 7, video: 0 }, buckets: [] };
      else if (options.url.endsWith('/refunds')) data = [{ id: 'prior-refund', orderId: 'prior-order', amountFen: 990, status: 'processing' }];
      else if (options.url.endsWith('/orders')) data = [{ id: 'prior-order', status: 'paid', platform: 'android',
        amountFen: 990, createdAt: 1, product: { name: '已购图片包' } }];
      if (!data) return false; options.success({ statusCode: 200, data: { code: 0, data } }); return true;
    } });
    f.wx.getDeviceInfo = () => ({ platform });
    const page = paymentPage(f); await page.onLoad();
    assert.equal(page.data.available, false); assert.equal(page.data.purchaseSupported, false);
    assert.equal(page.data.products.length, 0); assert.equal(page.data.photo, 7); assert.equal(page.data.orders.length, 1);
    assert.equal(page.data.refunds.length, 1); assert.match(page.data.refunds[0].statusText, /尚未确认到账/);
    assert.match(page.data.notice, /当前终端暂不支持购买/); assert.equal(f.nativeCalls(), 0);
  }
  const template = readFileSync(new URL('../../miniprogram/pages/payments/index.wxml', import.meta.url), 'utf8');
  assert.match(template, /class="rules" wx:if="\{\{purchaseSupported\}\}"/);
});

test('a formal pending order remains recoverable when sales close, without consulting catalog or creating a replacement', async () => {
  const f = setup({ requestOverride: options => {
    if (options.url.endsWith('/products')) assert.fail('pending recovery must not require an open catalog');
    return false;
  } });
  f.storage.set('lyx-payment-pending:buyer', { idempotencyKey: 'original-key', productId: 'photo10', orderId: 'order1' });
  const result = await f.client.buy('photo10', 'formal-rules', { ...confirmedPhoto, expectedEnv: 0 });
  assert.equal(result.pending, true); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders')).length, 0);
  assert.equal(f.storage.get('lyx-payment-pending:buyer').idempotencyKey, 'original-key');
});

const orderPosts = fixture => fixture.calls.filter(call => call.method === 'POST' && call.url.endsWith('/orders'));
const pendingPayment = fixture => fixture.storage.get('lyx-payment-pending:buyer');
const paymentReceipt = () => ({ order: { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990 }, payment: signedPhoto() });

test('inactive payment clients perform no login, requests, refunds, random-key writes or native payment', async () => {
  const f = setup(); f.client.setActive(false);
  const operations = [() => f.client.login(), () => f.client.products(), () => f.client.refund('order1', 'test'),
    () => f.client.confirmSandboxRefund('refund1'), () => f.client.refreshOrder('order1'),
    () => f.client.buy('photo10', 'rules', confirmedPhoto)];
  for (const operation of operations) await assert.rejects(operation(), { code: 'XPAY_PAGE_INACTIVE' });
  assert.equal(f.calls.length, 0); assert.equal(f.loginCalls(), 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
});

test('hide and hide/show cancel the original buy at native login, server auth, fresh catalog and random-key awaits', async t => {
  for (const reactivate of [false, true]) for (const phase of ['native-login', 'auth', 'catalog', 'random']) await t.test(`${phase}, reactivate=${reactivate}`, async () => {
    let release;
    const f = setup({ requestOverride: options => {
      if (phase === 'auth' && options.url.endsWith('/api/auth/wechat')) {
        release = () => apiReply(options, { token: 'held-token', user: { id: 'buyer' } }); return true;
      }
      if (phase === 'catalog' && options.url.endsWith('/products')) {
        release = () => apiReply(options, formalCatalog()); return true;
      }
    } });
    if (phase === 'native-login') f.wx.login = options => { release = () => options.success({ code: 'held-login' }); };
    if (phase === 'random') f.wx.getRandomValues = options => { release = () => options.success({ randomValues: new Uint8Array(16).fill(9).buffer }); };
    const buying = f.client.buy('photo10', 'rules', phase === 'catalog' ? { ...confirmedPhoto, expectedEnv: 0 } : confirmedPhoto);
    const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' });
    await flushPage(); assert.equal(typeof release, 'function');
    f.client.setActive(false); if (reactivate) f.client.setActive(true); release(); await rejected;
    assert.equal(orderPosts(f).length, 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
    if (phase === 'native-login') assert.equal(f.calls.length, 0);
  });
});

test('a late created-order receipt is bound to the original pending key and cannot start native payment or delete another account record', async () => {
  let held;
  const f = setup({ requestOverride: options => {
    if (options.method === 'POST' && options.url.endsWith('/orders')) { held = options; return true; }
  } });
  const other = { productId: 'photo10', idempotencyKey: 'other-account-key', orderId: 'other-order' };
  f.storage.set('lyx-payment-pending:other-buyer', structuredClone(other));
  const buying = f.client.buy('photo10', 'rules', confirmedPhoto);
  const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' });
  await flushPage(); assert.ok(held); const key = pendingPayment(f).idempotencyKey;
  f.client.setActive(false); f.client.setActive(true); apiReply(held, paymentReceipt()); await rejected;
  assert.equal(pendingPayment(f).idempotencyKey, key); assert.equal(pendingPayment(f).orderId, 'order1');
  assert.equal(f.nativeCalls(), 0); assert.deepEqual(f.storage.get('lyx-payment-pending:other-buyer'), other);
  const restarted = createPaymentClient(f.wx, 'https://example.com');
  const recovered = await restarted.buy('photo10', 'rules', confirmedPhoto);
  assert.equal(recovered.pending, true); assert.equal(orderPosts(f).length, 1); assert.equal(f.nativeCalls(), 0);
});

test('a late receipt cannot overwrite a newer attempt or restore a reconciled removed pending record', async () => {
  for (const replacement of [undefined, { productId: 'photo10', idempotencyKey: 'new-key', orderId: 'new-order' }]) {
    let held;
    const f = setup({ requestOverride: options => {
      if (options.method === 'POST' && options.url.endsWith('/orders')) { held = options; return true; }
    } });
    const buying = f.client.buy('photo10', 'rules', confirmedPhoto);
    const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' }); await flushPage();
    f.client.setActive(false);
    if (replacement) f.storage.set('lyx-payment-pending:buyer', structuredClone(replacement));
    else f.storage.delete('lyx-payment-pending:buyer');
    apiReply(held, paymentReceipt()); await rejected;
    assert.deepEqual(pendingPayment(f), replacement); assert.equal(f.nativeCalls(), 0);
  }
});

test('hiding during an order authentication rejection prevents fresh login and order replay while preserving the key', async () => {
  let held;
  const f = setup({ requestOverride: options => {
    if (options.method === 'POST' && options.url.endsWith('/orders')) { held = options; return true; }
  } });
  const buying = f.client.buy('photo10', 'rules', confirmedPhoto);
  const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' }); await flushPage();
  const key = pendingPayment(f).idempotencyKey; f.client.setActive(false);
  held.success({ statusCode: 401, data: { code: 'AUTH_EXPIRED' } }); await rejected;
  assert.equal(orderPosts(f).length, 1); assert.equal(f.loginCalls(), 1); assert.equal(f.nativeCalls(), 0);
  assert.equal(pendingPayment(f).idempotencyKey, key);
});

test('hiding after cashier opens keeps unknown payment pending and never treats a late native callback as cancellation or payment fact', async () => {
  for (const nativeOutcome of ['success', 'fail']) {
    let native;
    const f = setup({ requestOverride: options => {
      if (options.url.endsWith('/orders/order1')) { apiReply(options, { id: 'order1', status: 'pending', paymentRetryable: true }); return true; }
    } });
    f.wx.requestVirtualPayment = options => { native = options; };
    const buying = f.client.buy('photo10', 'rules', confirmedPhoto);
    const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' }); await flushPage(); assert.ok(native);
    assert.equal(pendingPayment(f).nativePaymentStarted, true);
    const before = f.calls.length; f.client.setActive(false); native[nativeOutcome]({}); await rejected;
    assert.equal(f.calls.length, before); assert.equal(pendingPayment(f).orderId, 'order1');
    const restarted = createPaymentClient(f.wx, 'https://example.com');
    assert.equal((await restarted.buy('photo10', 'rules', confirmedPhoto)).pending, true);
    assert.equal(orderPosts(f).length, 1, 'even a remote unpaid status cannot authorize a second cashier for an unknown native result');
    assert.equal(pendingPayment(f).nativePaymentStarted, true);
  }
});

test('a paid lookup arriving after hiding cannot remove pending; a fresh active authoritative query may clear it', async () => {
  let held, hold = true;
  const f = setup({ requestOverride: options => {
    if (hold && options.url.endsWith('/orders/order1')) { held = options; return true; }
  } });
  const buying = f.client.buy('photo10', 'rules', confirmedPhoto);
  const rejected = assert.rejects(buying, { code: 'XPAY_PAGE_INACTIVE' }); await flushPage(); assert.ok(held);
  f.client.setActive(false); apiReply(held, { id: 'order1', status: 'paid' }); await rejected;
  assert.equal(pendingPayment(f).orderId, 'order1');
  hold = false; f.client.setActive(true);
  f.wx.request = options => apiReply(options, { id: 'order1', status: 'paid' });
  assert.equal((await f.client.refreshOrder('order1')).status, 'paid'); assert.equal(pendingPayment(f), undefined);
});

test('reconnected clients waiting for randomness share the persisted intent instead of creating a second key or cashier', async () => {
  const f = setup(); const heldRandom = [];
  f.wx.getRandomValues = options => heldRandom.push(options);
  const second = createPaymentClient(f.wx, 'https://example.com');
  const firstBuy = f.client.buy('photo10', 'rules', confirmedPhoto);
  const secondBuy = second.buy('photo10', 'rules', confirmedPhoto);
  const secondRejected = assert.rejects(secondBuy, /正在确认/); await flushPage(); assert.equal(heldRandom.length, 2);
  heldRandom[0].success({ randomValues: new Uint8Array(16).fill(1).buffer }); await firstBuy;
  const original = structuredClone(pendingPayment(f));
  heldRandom[1].success({ randomValues: new Uint8Array(16).fill(2).buffer }); await secondRejected;
  assert.equal(orderPosts(f).length, 1); assert.equal(f.nativeCalls(), 1); assert.deepEqual(pendingPayment(f), original);
});

test('optional fresh catalog validator rejects changed quantities, days or generation scope before any order/key/native side effect', async () => {
  const original = formalCatalog(); original.generationEnabled = true;
  const agreedProduct = structuredClone(original.products[0]);
  const valid = catalog => catalog.generationEnabled === true && catalog.products.length === 1
    && JSON.stringify(catalog.products[0]) === JSON.stringify(agreedProduct);
  for (const mutate of [catalog => { catalog.products[0].days = 30; },
    catalog => { catalog.products[0].components[0].quantity = 5; }, catalog => { catalog.generationEnabled = false; }]) {
    const changed = structuredClone(original); mutate(changed);
    const f = setup({ requestOverride: options => {
      if (options.url.endsWith('/products')) { apiReply(options, changed); return true; }
    } });
    await assert.rejects(f.client.buy('photo10', 'rules', { ...confirmedPhoto, expectedEnv: 0, validateFreshCatalog: valid }), { code: 'XPAY_PAYMENT_CATALOG_CHANGED' });
    assert.equal(orderPosts(f).length, 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
  }
});

test('fresh catalog validator is snapshotted before login and must synchronously return true', async () => {
  for (const verdict of [false, undefined, Promise.resolve(true)]) {
    let held;
    const f = setup({ requestOverride: options => {
      if (options.url.endsWith('/api/auth/wechat')) { held = options; return true; }
      if (options.url.endsWith('/products')) { apiReply(options, formalCatalog()); return true; }
    } });
    const confirmation = { ...confirmedPhoto, validateFreshCatalog: () => verdict };
    const buying = f.client.buy('photo10', 'rules', confirmation);
    const rejected = assert.rejects(buying, { code: 'XPAY_PAYMENT_CATALOG_CHANGED' }); await flushPage();
    confirmation.validateFreshCatalog = () => true;
    apiReply(held, { token: 'held', user: { id: 'buyer' } }); await rejected;
    assert.equal(f.calls.filter(call => call.url.endsWith('/products')).length, 1, 'validator requests a fresh catalog even for an existing env1 caller');
    assert.equal(orderPosts(f).length, 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
  }
});

test('two active clients reuse one persisted order intent and only the first accepted receipt can open the cashier', async () => {
  const orders = [], random = [];
  const f = setup({ requestOverride: options => {
    if (options.method === 'POST' && options.url.endsWith('/orders')) { orders.push(options); return true; }
  } });
  f.wx.getRandomValues = options => random.push(options);
  const other = createPaymentClient(f.wx, 'https://example.com');
  const first = f.client.buy('photo10', 'rules', confirmedPhoto), second = other.buy('photo10', 'rules', confirmedPhoto);
  await flushPage(); assert.equal(random.length, 2);
  random[0].success({ randomValues: new Uint8Array(16).fill(3).buffer }); await flushPage(); assert.equal(orders.length, 1);
  random[1].success({ randomValues: new Uint8Array(16).fill(8).buffer }); await flushPage(); assert.equal(orders.length, 2);
  assert.equal(orders[0].header['Idempotency-Key'], orders[1].header['Idempotency-Key']);
  apiReply(orders[0], paymentReceipt()); await first; apiReply(orders[1], paymentReceipt()); await second;
  assert.equal(f.nativeCalls(), 1); assert.equal(pendingPayment(f).nativePaymentStarted, true);
});

test('refund and sandbox confirmation waiting for account login are cancelled before their POST when hidden', async () => {
  for (const action of [client => client.refund('order1', 'test'), client => client.confirmSandboxRefund('refund1')]) {
    let held;
    const f = setup({ requestOverride: options => {
      if (options.url.endsWith('/api/auth/wechat')) { held = options; return true; }
    } });
    const operation = action(f.client), rejected = assert.rejects(operation, { code: 'XPAY_PAGE_INACTIVE' });
    await flushPage(); f.client.setActive(false); apiReply(held, { token: 'held', user: { id: 'buyer' } }); await rejected;
    assert.equal(f.calls.filter(call => call.method === 'POST' && !call.url.endsWith('/api/auth/wechat')).length, 0);
  }
});

test('actual payment page cancels a buy whose fresh login returns after onHide, including a newer connected page', async () => {
  for (const reconnect of [false, true]) {
    let held, authentications = 0;
    const f = paymentReadFixture(options => {
      if (options.url.endsWith('/api/auth/wechat') && ++authentications === 2) { held = options; return true; }
    });
    f.wx.showModal = options => options.success?.({ confirm: true });
    const page = paymentPage(f); await page.onLoad(); page.data.agreement = true;
    const buying = page.buy(photoBuyEvent); await flushPage(); assert.ok(held);
    page.onHide();
    if (reconnect) { page.onShow(); await page.connect(); assert.equal(page.data.connected, true); }
    apiReply(held, { token: 'old-login-response', user: { id: 'buyer' } }); await buying;
    assert.equal(orderPosts(f).length, 0); assert.equal(f.nativeCalls(), 0); assert.equal(f.storage.size, 0);
    assert.equal(page.data.connected, reconnect); assert.equal(page.data.loading, false);
  }
});
