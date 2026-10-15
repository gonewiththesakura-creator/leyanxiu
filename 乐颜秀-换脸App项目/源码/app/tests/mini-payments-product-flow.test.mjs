import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { createPaymentClient } = require('../miniprogram/payments.js');
const ids = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
const source = readFileSync(new URL('../miniprogram/pages/payments/index.js', import.meta.url), 'utf8');
function fixture({ mutate = () => {}, platform = 'android', previous, intercept } = {}) {
  const catalog = { settings: { generationEnabled: true }, miniProgramCreation: { available: true,
    photoEffectIds: [...ids], jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1' },
    photoEffects: ids.map(id => ({ id, enabled: true })) };
  const products = { available: true, ledgerOnlySandbox: false, mode: 'merchant_test', purchaseProfile: 'android-only-v1',
    supportedPlatforms: ['android'], rulesVersion: 'mini-pay-v1-20260927', products: [{ id: 'photo10', name: '图片处理10次包',
      amountFen: 990, type: 'pack', days: 365, components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] }] };
  mutate({ catalog, products });
  let page, creates = 0, native = 0, pageStack = previous ? [previous, { route: 'pages/payments/index' }] : [{ route: 'pages/payments/index' }];
  const calls = [], navigation = [], storage = new Map();
  const order = { id: 'owned-order', status: 'pending', productId: 'photo10', amountFen: 990, createdAt: 1,
    platform: 'android', product: { id: 'photo10', name: '已购图片包' }, paymentRetryable: false };
  const wx = {
    getPrivacySetting: o => o.success({ needAuthorization: false }), requirePrivacyAuthorize: o => o.success({}),
    login: o => o.success({ code: 'fixture-only' }), getDeviceInfo: () => ({ platform }), canIUse: () => true,
    getRandomValues: o => o.success({ randomValues: new Uint8Array(16).fill(1).buffer }),
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    request: o => {
      calls.push(o); const route = new URL(o.url).pathname;
      if (intercept?.(route, o)) return;
      let data;
      if (route === '/api/auth/wechat') data = { token: 'fixture-token', user: { id: 'buyer' } };
      else if (route === '/api/catalog') data = catalog;
      else if (route.endsWith('/products')) data = products;
      else if (route.endsWith('/entitlements')) data = { available: { photo: 7, video: 0 }, buckets: [] };
      else if (route.endsWith('/refunds')) data = [{ id: 'refund1', orderId: order.id, amountFen: 297, status: 'processing' }];
      else if (route.endsWith('/orders') && o.method === 'POST') { creates++; data = { order }; }
      else if (route.endsWith('/orders')) data = [order];
      else if (route.endsWith('/orders/' + order.id)) data = order;
      else assert.fail('Unexpected request: ' + route);
      o.success({ statusCode: 200, data: { code: 0, data: structuredClone(data) } });
    },
    showModal: o => o.success?.({ confirm: true }), showToast: () => {},
    requestVirtualPayment: () => { native++; assert.fail('No cashier is needed by this fixture'); },
    navigateBack: o => navigation.push(['back', o.delta]), redirectTo: o => navigation.push(['redirect', o.url]),
    switchTab: o => navigation.push(['tab', o.url]), navigateTo: o => navigation.push(['push', o.url]), stopPullDownRefresh: () => {},
  };
  const privacyModule = { exports: {} };
  runInNewContext(readFileSync(new URL('../miniprogram/privacy-consent.js', import.meta.url), 'utf8'), { wx, module: privacyModule });
  runInNewContext(source, { wx, getCurrentPages: () => pageStack,
    getApp: () => ({ globalData: { apiTransport: 'https://example.test' } }),
    require: name => name === '../../privacy-consent' ? privacyModule.exports : { createPaymentClient },
    Page: value => { page = value; } });
  page.data = structuredClone(page.data); page.setData = value => Object.assign(page.data, value);
  return { page, calls, navigation, storage, wx, creates: () => creates, native: () => native,
    stack: value => { pageStack = value; } };
}
const event = id => ({ currentTarget: { dataset: { id } } });

test('product page uses the current sole quote and exact three-effect scope without ordering on load or tab changes', async () => {
  const f = fixture(); await f.page.onLoad();
  assert.equal(f.page.data.available, true); assert.equal(f.page.data.photo, 7);
  assert.deepEqual(Array.from(f.page.data.includedEffects, row => row.id), ids);
  assert.equal(f.page.data.products.length, 1); const product = f.page.data.products[0];
  assert.equal(product.price, '9.90'); assert.equal(product.days, 365); assert.equal(product.rights, '图片 10 次');
  assert.equal(f.page.data.merchantTest, true);
  f.page.selectTab({ currentTarget: { dataset: { tab: 'orders' } } }); assert.equal(f.page.data.activeTab, 'orders');
  f.page.selectTab({ currentTarget: { dataset: { tab: 'plans' } } }); assert.equal(f.page.data.activeTab, 'plans');
  assert.equal(f.creates(), 0); assert.equal(f.native(), 0);
  assert.equal(f.calls.some(call => /upload|photo-jobs|consent/.test(call.url)), false);
});

test('scope, SKU, price, quantity and expiry drift close only new sales while preserving owned orders and refunds', async () => {
  for (const mutate of [
    ({ catalog }) => { catalog.photoEffects.pop(); },
    ({ catalog }) => { catalog.photoEffects[2] = { id: 'classic-black-white', enabled: true }; },
    ({ catalog }) => { catalog.miniProgramCreation.photoEffectIds[2] = ids[0]; },
    ({ catalog }) => { catalog.photoEffects[1].available = false; },
    ({ products }) => { products.products[0].days = 9999; },
    ({ products }) => { products.products[0].amountFen = 1990; },
    ({ products }) => { products.products[0].components[0].quantity = 20; },
    ({ products }) => { products.products.push({ ...products.products[0], id: 'member30' }); },
  ]) {
    const f = fixture({ mutate }); await f.page.onLoad();
    assert.equal(f.page.data.available, false); assert.equal(f.page.data.products.length, 0);
    assert.equal(f.page.data.photo, 7); assert.equal(f.page.data.orders.length, 1); assert.equal(f.page.data.refunds.length, 1);
    f.page.data.agreement = true; await f.page.buy(event('photo10')); assert.equal(f.creates(), 0);
  }
});

test('unsupported terminals retain account queries and never advertise a new payable product', async () => {
  const f = fixture({ platform: 'ios' }); await f.page.onLoad();
  assert.equal(f.page.data.products.length, 0); assert.equal(f.page.data.available, false);
  assert.equal(f.page.data.orders.length, 1); assert.equal(f.page.data.photo, 7); assert.equal(f.native(), 0);
});

test('unavailable scope read preserves account rights and refund progress but closes new sales', async () => {
  const f = fixture({ intercept: (route, options) => {
    if (route === '/api/catalog') { options.success({ statusCode: 503, data: { code: 'UNAVAILABLE' } }); return true; }
  } });
  await f.page.onLoad(); assert.equal(f.page.data.available, false); assert.equal(f.page.data.products.length, 0);
  assert.equal(f.page.data.orders.length, 1); assert.equal(f.page.data.photo, 7); assert.equal(f.page.data.refunds.length, 1);
});

test('creation return validates the source and selection and performs navigation only', async () => {
  for (const id of ids) {
    const f = fixture({ previous: { route: 'pages/create/index', data: { effectId: id } } });
    await f.page.onLoad({ returnTo: 'creation', effectId: id }); const count = f.calls.length;
    f.page.openCreation(); assert.deepEqual(f.navigation, [['back', 1]]); assert.equal(f.calls.length, count);
    const other = fixture({ previous: { route: 'pages/create/index', data: { effectId: ids.find(value => value !== id) } } });
    await other.page.onLoad({ returnTo: 'creation', effectId: id }); other.page.openCreation();
    assert.deepEqual(other.navigation, [['redirect', '/pages/create/index?effectId=' + id]]);
  }
  for (const options of [{}, { effectId: ids[0] }, { returnTo: 'creation', effectId: 'classic-black-white' },
    { returnTo: 'creation', effectId: '__proto__' }, { returnTo: 'https://other.test', effectId: ids[0] }]) {
    const f = fixture(); await f.page.onLoad(options); f.page.openCreation();
    assert.deepEqual(f.navigation, [['tab', '/pages/photos/index']]); assert.equal(f.creates(), 0);
  }
});

test('native back failure redirects to the same effect without an order or photo operation', async () => {
  const f = fixture({ previous: { route: 'pages/create/index', data: { effectId: ids[1] } } });
  f.wx.navigateBack = o => o.fail(); await f.page.onLoad({ returnTo: 'creation', effectId: ids[1] });
  f.page.openCreation(); assert.deepEqual(f.navigation, [['redirect', '/pages/create/index?effectId=modern-comic']]);
  assert.equal(f.creates(), 0); assert.equal(f.native(), 0);
});

test('pending payment survives hide/show and explicit reconnect without creating a replacement order', async () => {
  const f = fixture(); await f.page.onLoad(); f.page.data.agreement = true;
  await f.page.buy(event('photo10')); assert.equal(f.creates(), 1); assert.equal(f.page.data.activeTab, 'orders');
  const pending = structuredClone(f.storage.get('lyx-payment-pending:buyer')), count = f.calls.length;
  f.page.onHide(); f.page.onShow(); assert.equal(f.calls.length, count); assert.equal(f.page.data.connected, false);
  await f.page.connect(); assert.equal(f.creates(), 1); assert.deepEqual(f.storage.get('lyx-payment-pending:buyer'), pending);
  f.page.data.agreement = true; await f.page.buy(event('photo10')); assert.equal(f.creates(), 1); assert.equal(f.native(), 0);
});

test('late catalog scope response cannot restore purchase admission after leaving the page', async () => {
  let held;
  const f = fixture({ intercept: (route, options) => { if (route === '/api/catalog') { held = options; return true; } } });
  const loading = f.page.onLoad(); while (!held) await new Promise(resolve => setImmediate(resolve));
  f.page.onHide(); f.page.onShow(); held.success({ statusCode: 200, data: { code: 0, data: {} } }); await loading;
  assert.equal(f.page.data.connected, false); assert.equal(f.page.data.available, false); assert.equal(f.page.data.products.length, 0);
  assert.equal(f.creates(), 0);
});

test('contract changes while the confirmation dialog is open cannot create an order at the same ID and price', async () => {
  for (const change of [
    ({ products }) => { products.products[0].components[0].quantity = 5; },
    ({ products }) => { products.products[0].days = 30; },
    ({ catalog }) => { catalog.settings.generationEnabled = false; },
  ]) {
    let live;
    const f = fixture({ mutate: value => { live = value; } });
    await f.page.onLoad(); assert.equal(f.page.data.available, true);
    f.page.data.agreement = true;
    f.wx.showModal = options => { change(live); options.success({ confirm: true }); };
    await f.page.buy(event('photo10'));
    assert.equal(f.creates(), 0); assert.equal(f.native(), 0);
    assert.equal(f.page.data.available, false);
  }
});
