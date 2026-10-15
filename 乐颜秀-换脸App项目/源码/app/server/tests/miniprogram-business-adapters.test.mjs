import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const { resolvePhotoEffectId, photoSelection, photoCards, videoCards, generateSelectedPhoto } = require('../../miniprogram/business-adapters.js');
const { createCreationClient } = require('../../miniprogram/creation.js');
const { createPaymentClient } = require('../../miniprogram/payments.js');

const merchantPolicy = JSON.parse(readFileSync(new URL('../docs/production-config/natural-avatar-merchant-policy-2026-10-13.json', import.meta.url), 'utf8'));
const approvedAvatar = merchantPolicy.approvedEffects.find(effect => effect.id === 'natural-avatar');
const nativeEffectIds = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
const ready = () => ({ available: true, effects: [{ id: approvedAvatar.id, included: true, available: true }] });
const consent = { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', basicVersion: 'basic-v1', faceVersion: 'face-v1' };
const selection = { effectId: 'natural-avatar', image: 'data:image/png;base64,iVBORw0KGgo=', consent };

test('a full visual catalog never turns preview-only effects into the one approved effect', () => {
  const effects = [{ id: 'natural-avatar', title: '自然AI头像', subtitle: '原文' },
    { id: 'age-change', enabled: true, available: true, serviceEffectId: approvedAvatar.id },
    { id: 'face-enhance', available: true }];
  const cards = photoCards(effects, ready());
  assert.deepEqual(cards.map(item => item.id), effects.map(item => item.id));
  assert.deepEqual(cards.map(item => item.canCreate), [true, false, false]);
  assert.equal(cards[0].serviceEffectId, approvedAvatar.id);
  assert.notEqual(cards[0].serviceEffectId, approvedAvatar.version);
  assert.equal(cards[1].serviceEffectId, null);
  assert.equal(cards[0].title, effects[0].title);
  assert.match(cards[0].subtitle, /细节可能改变/);
  assert.deepEqual(effects[0], { id: 'natural-avatar', title: '自然AI头像', subtitle: '原文' });
});

test('missing, contradictory and string-valued capability facts fail closed', () => {
  for (const snapshot of [null, {}, { ...ready(), available: 'true' },
    { available: true, effects: [{ id: approvedAvatar.id, available: true }] },
    { available: true, effects: [{ id: approvedAvatar.id, included: true, available: 'true' }] },
    { available: true, effects: [{ id: approvedAvatar.version, included: true, available: true }] },
    { available: true, effects: [ready().effects[0], ready().effects[0]] }]) {
    assert.equal(photoSelection('natural-avatar', snapshot).canCreate, false);
  }
  assert.equal(photoCards([{ id: 'natural-avatar', enabled: false }], ready())[0].canCreate, false);
  for (const id of ['constructor', '__proto__', 'toString', 'natural-avatar-v2', 'natural-avatar ', undefined]) {
    assert.equal(resolvePhotoEffectId(id), null);
    assert.equal(photoSelection(id, ready()).canCreate, false);
  }
});

test('only three exact native IDs are bound and the full legacy catalog remains visible with honest subtitles', () => {
  const catalog = require('../../miniprogram/catalog/effects.js');
  const local = catalog.PHOTO_EFFECTS;
  assert.ok(Array.isArray(local));
  const before = structuredClone(local), snapshot = { available: true,
    effects: nativeEffectIds.map(id => ({ id, included: true, available: true })) };
  const cards = photoCards(local, snapshot);
  assert.equal(local.length, 17); assert.equal(cards.filter(card => !card.canCreate).length, 14);
  assert.deepEqual(cards.map(card => card.id), local.map(card => card.id));
  assert.equal(cards.length, local.length); assert.deepEqual(local, before);
  assert.deepEqual(cards.filter(card => card.canCreate).map(card => card.id), nativeEffectIds);
  for (const id of nativeEffectIds) {
    assert.equal(resolvePhotoEffectId(id), id);
    const card = cards.find(row => row.id === id);
    assert.equal(card.serviceEffectId, id); assert.match(card.subtitle, /细节可能改变/);
    assert.doesNotMatch(card.subtitle, /保真|不改变|保持原样|还是熟悉的自己|保留真实年龄/);
  }
  for (const card of cards.filter(card => !nativeEffectIds.includes(card.id))) {
    assert.equal(card.canCreate, false); assert.equal(card.serviceEffectId, null); assert.equal(card.availabilityLabel, '暂未开放');
  }
});

test('each native effect needs one exact included and available server entry', () => {
  for (const id of nativeEffectIds) {
    const entry = { id, included: true, available: true }, okay = { available: true, effects: [entry] };
    assert.equal(photoSelection(id, okay).canCreate, true);
    for (const snapshot of [null, { effects: [entry] }, { ...okay, available: false }, { ...okay, available: 'true' },
      { available: true, effects: [] }, { available: true, effects: [{ ...entry, included: false }] },
      { available: true, effects: [{ ...entry, available: false }] }, { available: true, effects: [{ ...entry, included: 'true' }] },
      { available: true, effects: [entry, entry] }, { available: true, effects: [entry, { ...entry, available: false }] },
      { available: true, effects: [{ ...entry, id: `${id}-v1-20261015` }] }]) {
      assert.equal(photoSelection(id, snapshot).canCreate, false, `${id} with ${JSON.stringify(snapshot)}`);
    }
  }
  for (const id of ['classic-black-white', 'new-chinese', 'comic', 'watercolor', 'modern-comic ', 'constructor', '__proto__']) {
    assert.equal(resolvePhotoEffectId(id), null);
    assert.equal(photoSelection(id, { available: true, effects: [{ id, included: true, available: true }] }).canCreate, false);
  }
});

test('video previews never inherit a stale or injected creation flag', () => {
  assert.deepEqual(videoCards([{ id: 'quote', available: true, canCreate: true }]),
    [{ id: 'quote', available: false, canCreate: false, availabilityLabel: '模板预览 · 创作暂未开放' }]);
  const templates = require('../../miniprogram/catalog/templates.js').VIDEO_TEMPLATES;
  const before = structuredClone(templates), cards = videoCards(templates);
  assert.equal(cards.length, templates.length); assert.deepEqual(cards.map(card => card.id), templates.map(template => template.id));
  assert.ok(cards.every(card => card.available === false && card.canCreate === false));
  assert.deepEqual(templates, before);
});

// All requests stay in this in-memory fake wx transport. The tested clients
// are the real native clients; no cloud, model or payment channel is contacted.
function fixture({ effectIds = [approvedAvatar.id], declaredEffectIds = effectIds } = {}) {
  const storage = new Map(), calls = [];
  let account = 'accountA', random = 0, nativePayments = 0, generationEnabled = true;
  const job = { id: 'job1', state: 'queued' };
  const order = { id: 'order1', status: 'pending', productId: 'photo10', amountFen: 990, paymentRetryable: false };
  const response = data => ({ statusCode: 200, data: { code: 0, data } });
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    login: options => options.success({ code: 'fictional-code' }),
    getRandomValues: options => options.success({ randomValues: new Uint8Array(16).fill(++random).buffer }),
    canIUse: () => true, getDeviceInfo: () => ({ platform: 'android' }),
    requestVirtualPayment: options => { nativePayments++; options.success({}); },
    cloud: { async callContainer(options) {
      const path = options.path; calls.push({ path, method: options.method, data: options.data });
      if (path === '/api/auth/wechat') return response({ token: `fictional-${account}`, user: { id: account } });
      if (path === '/api/catalog') return response({ settings: { generationEnabled },
        miniProgramCreation: { available: generationEnabled, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: [...declaredEffectIds] },
        photoEffects: effectIds.map(id => ({ id, enabled: true })) });
      if (path === '/api/public/compliance') return response({ status: 'approved', operatorName: 'Fictional Operator',
        consentVersions: { basic: 'basic-v1', faceProcessing: 'face-v1' },
        retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'fictional policy' },
        aiServices: [{ provider: 'fictional', model: 'fictional', filingReference: 'fictional', purpose: 'fictional', region: 'fictional', capabilities: ['photo-effect'] }] });
      if (path === '/api/capabilities') return response([{ id: 'photo-effects', ready: true, status: 'verified' }]);
      if (path === '/api/mini/payments/entitlements') return response({ available: { photo: 10, video: 0 } });
      if (path === '/api/works') return response([]);
      if (path === '/api/consents') return response({ current: { basic: 'basic-v1', face_processing: 'face-v1' } });
      if (path === '/api/mini/photo-uploads') return response({ upload: {
        id: `upload_${'1'.repeat(32)}`, state: 'ready', createdAt: 1, updatedAt: 1, assetId: 'input1' } });
      if (path === '/api/mini/photo-jobs' || path === '/api/mini/photo-jobs/job1') return response({ job });
      if (path === '/api/mini/payments/orders' && options.method === 'POST') return response({ order, payment: {
        mode: 'short_series_goods', paySig: 'fictional', signature: 'fictional',
        signData: JSON.stringify({ env: 1, goodsPrice: 990, productId: 'photo10', outTradeNo: 'order1', buyQuantity: 1, currencyType: 'CNY' }) } });
      if (path === '/api/mini/payments/orders/order1') return response(order);
      throw new Error(`Unexpected fixture route: ${path}`);
    } },
  };
  const endpoint = { mode: 'cloud', env: 'fictional-env', service: 'fictional-service' };
  return { storage, calls, create: createCreationClient(wx, endpoint, { enabled: true }),
    payment: createPaymentClient(wx, endpoint), switchAccount: () => { account = 'accountB'; },
    closeCreation: () => { generationEnabled = false; }, nativePayments: () => nativePayments };
}

test('unknown selection never contacts a provider, even when another effect is ready', async () => {
  const f = fixture();
  await assert.rejects(generateSelectedPhoto(f.create, { ...selection, effectId: 'age-change' }), { code: 'CREATION_NOT_AVAILABLE' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.nativePayments(), 0);
});

test('selection reaches the real creation client and job submission without cross-mapping any of the three IDs', async () => {
  for (const id of nativeEffectIds) {
    const f = fixture({ effectIds: nativeEffectIds });
    assert.equal(photoSelection(id, await f.create.refresh()).canCreate, true);
    const result = await generateSelectedPhoto(f.create, { ...selection, effectId: id });
    assert.equal(result.pending, true);
    const jobs = f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST');
    assert.equal(jobs.length, 1); assert.equal(jobs[0].data.effectId, id);
    assert.equal(f.storage.get('lyx-creation-pending:accountA').effectId, id);
    assert.equal(f.nativePayments(), 0);
  }
});

test('missing availability, duplicate and unapproved selections never reach client.generate or choose another ready ID', async () => {
  for (const id of nativeEffectIds) {
    const entry = { id, included: true, available: true };
    for (const snapshot of [{ available: false, effects: [entry] }, { available: true, effects: [{ ...entry, included: false }] },
      { available: true, effects: [{ ...entry, available: false }] }, { available: true, effects: [entry, entry] },
      { available: true, effects: [{ id: id === 'modern-comic' ? 'gentle-watercolor' : 'modern-comic', included: true, available: true }] }]) {
      let generated = 0;
      const client = { refresh: async () => snapshot, generate: async () => { generated++; } };
      await assert.rejects(generateSelectedPhoto(client, { ...selection, effectId: id }), { code: 'CREATION_NOT_AVAILABLE' });
      assert.equal(generated, 0);
    }
  }
  let refreshed = 0, generated = 0;
  const client = { refresh: async () => { refreshed++; return { available: true, effects: nativeEffectIds.map(id => ({ id, included: true, available: true })) }; },
    generate: async () => { generated++; } };
  for (const id of ['unknown', 'classic-black-white', 'new-chinese', 'modern-comic-v1-20261015']) {
    await assert.rejects(generateSelectedPhoto(client, { ...selection, effectId: id }), { code: 'CREATION_NOT_AVAILABLE' });
  }
  assert.equal(refreshed, 0); assert.equal(generated, 0);
});

test('actual duplicate server catalog entries prevent upload and a waiting refresh cannot switch the selected ID', async () => {
  for (const id of nativeEffectIds) {
    const f = fixture({ effectIds: [id, id] });
    await assert.rejects(generateSelectedPhoto(f.create, { ...selection, effectId: id }), { code: 'CREATION_NOT_AVAILABLE' });
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path !== '/api/auth/wechat').length, 0);
    assert.equal(f.nativePayments(), 0);
  }
  let finishRefresh, delivered;
  const client = { refresh: () => new Promise(resolve => { finishRefresh = resolve; }), generate: async value => { delivered = value; } };
  const input = { ...selection, effectId: 'modern-comic' }, expected = { ...input };
  const pending = generateSelectedPhoto(client, input);
  input.effectId = 'gentle-watercolor'; input.image = 'replacement';
  finishRefresh({ available: true, effects: nativeEffectIds.map(id => ({ id, included: true, available: true })) });
  await pending; assert.deepEqual(delivered, expected);
});

test('stale displayed availability cannot bypass a newly closed server capability', async () => {
  const f = fixture();
  assert.equal(photoSelection('natural-avatar', await f.create.refresh()).canCreate, true);
  f.closeCreation();
  await assert.rejects(generateSelectedPhoto(f.create, selection), { code: 'CREATION_NOT_AVAILABLE' });
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path !== '/api/auth/wechat').length, 0);
  assert.equal(f.nativePayments(), 0);
});

test('mapped creation retains existing duplicate-tap and unresolved-job protection', async () => {
  const f = fixture();
  const first = generateSelectedPhoto(f.create, selection);
  await assert.rejects(generateSelectedPhoto(f.create, selection), { code: 'CREATION_IN_PROGRESS' });
  assert.equal((await first).pending, true);
  await assert.rejects(generateSelectedPhoto(f.create, selection), { code: 'CREATION_UNCONFIRMED' });
  const jobs = f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].data, { inputAssetId: 'input1', effectId: approvedAvatar.id });
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-uploads').length, 1);
  assert.equal(f.nativePayments(), 0);
});

test('a repeated payment tap preserves one native payment and one server-owned order', async () => {
  const f = fixture();
  const confirmed = { expectedAmountFen: 990, expectedProductId: 'photo10', expectedEnv: 1 };
  const first = f.payment.buy('photo10', 'rules-v1', confirmed);
  await assert.rejects(f.payment.buy('photo10', 'rules-v1', confirmed), /上一笔支付/);
  assert.equal((await first).order.status, 'pending');
  assert.equal((await f.payment.buy('photo10', 'rules-v1', confirmed)).pending, true);
  assert.equal(f.nativePayments(), 1);
  const orders = f.calls.filter(call => call.path === '/api/mini/payments/orders' && call.method === 'POST');
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0].data, { productId: 'photo10', platform: 'android', agreed: true, rulesVersion: 'rules-v1' });
});

test('account change invalidates actions and does not transfer or delete the old account intent', async () => {
  const f = fixture();
  await generateSelectedPhoto(f.create, selection);
  const originalPending = structuredClone(f.storage.get('lyx-creation-pending:accountA'));
  f.switchAccount();
  await assert.rejects(f.create.refresh(), { code: 'XPAY_ACCOUNT_CHANGED' });
  await assert.rejects(generateSelectedPhoto(f.create, selection), { code: 'XPAY_ACCOUNT_CHANGED' });
  assert.deepEqual(f.storage.get('lyx-creation-pending:accountA'), originalPending);
  assert.equal(f.storage.has('lyx-creation-pending:accountB'), false);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST').length, 1);
});

function pageSnapshot(effects = [{ id: approvedAvatar.id, title: '自然 AI 头像', included: true, available: true }]) {
  return { available: true, photo: 10, effects, works: [], services: [],
    compliance: { consentVersions: { basic: 'basic-v1', faceProcessing: 'face-v1' } } };
}
function createPage(client) {
  let page;
  const toasts = [], scrolls = [];
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/create/index.js', import.meta.url), 'utf8'), {
    require: name => { if (name === '../../photo-input') return require('../../miniprogram/photo-input.js'); assert.equal(name, '../../creation'); return { createCreationClient: () => client, imageLimit: 2 * 1024 * 1024 }; },
    Page: value => { page = value; },
    wx: { showToast: value => toasts.push(value), pageScrollTo: value => scrolls.push(value),
      getPrivacySetting: options => options.success({ needAuthorization: false }), requirePrivacyAuthorize: options => options.success({}) },
    getApp: () => ({ globalData: { creationEnabled: true, apiTransport: {} } }),
    setTimeout: () => 1, clearTimeout: () => {},
  });
  page.data = structuredClone(page.data);
  page.setData = value => Object.assign(page.data, value);
  page.photoData = selection.image;
  Object.assign(page.data, { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self' });
  return { page, toasts, scrolls };
}

test('an unavailable route selection remains selected and cannot use the first available effect', async () => {
  let generations = 0;
  const client = { entitlements: async () => ({ available: { photo: 10 } }), refresh: async () => pageSnapshot(),
    generate: async () => { generations++; } };
  const { page, toasts } = createPage(client);
  await page.onLoad({ effectId: 'unknown-effect' });
  assert.equal(page.data.effectId, 'unknown-effect');
  assert.equal(page.data.effectAvailable, false);
  assert.match(page.data.effectTitle, /不可用/);
  await page.generate();
  assert.equal(generations, 0);
  assert.match(toasts[0].title, /暂未开放/);
});

test('the actual create page submits all three selected IDs through the real creation client without substitution', async () => {
  for (const id of nativeEffectIds) {
    const f = fixture({ effectIds: nativeEffectIds });
    const { page } = createPage(f.create);
    await page.onLoad({ effectId: id });
    assert.equal(page.data.effectId, id); assert.equal(page.data.effectAvailable, true);
    Object.assign(page.data, { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self' });
    await page.generate();
    const posts = f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST');
    assert.equal(posts.length, 1); assert.equal(posts[0].data.effectId, id);
    assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-uploads' && call.method === 'POST').length, 1);
    assert.equal(f.nativePayments(), 0);
  }
});

test('core creation client and actual page reject duplicate catalog, duplicate declaration and excluded effects', async () => {
  for (const id of nativeEffectIds) {
    for (const options of [{ effectIds: [id, id], declaredEffectIds: [id] },
      { effectIds: [id], declaredEffectIds: [id, id] }, { effectIds: nativeEffectIds, declaredEffectIds: nativeEffectIds.filter(item => item !== id) }]) {
      const f = fixture(options), { page } = createPage(f.create);
      await page.onLoad({ effectId: id });
      assert.equal(page.data.effectId, id); assert.equal(page.data.effectAvailable, false);
      await page.generate();
      await assert.rejects(f.create.generate({ ...selection, effectId: id }), { code: 'CREATION_NOT_AVAILABLE' });
      assert.equal(f.calls.filter(call => call.method === 'POST' && call.path !== '/api/auth/wechat').length, 0);
    }
  }
});

test('actual create page requires an explicit effect and will not fall back on load or duplicate selection', async () => {
  const entries = nativeEffectIds.map(id => ({ id, included: true, available: true }));
  let generated = 0;
  const { page } = createPage({ entitlements: async () => ({ available: { photo: 10 } }),
    refresh: async () => pageSnapshot(entries), generate: async () => { generated++; } });
  await page.onLoad(); assert.equal(page.data.effectId, ''); assert.equal(page.data.effectAvailable, false);
  await page.generate(); assert.equal(generated, 0);
  page.data.effects = [entries[0], entries[0], entries[1]];
  page.chooseEffect({ currentTarget: { dataset: { id: entries[0].id } } });
  assert.equal(page.data.effectId, entries[0].id); assert.equal(page.data.effectAvailable, false);
  await page.generate(); assert.equal(generated, 0);
});

test('a previously selected effect becoming disabled neither substitutes another effect nor submits', async () => {
  let enabled = true, generations = 0;
  const client = { entitlements: async () => ({ available: { photo: 10 } }),
    refresh: async () => pageSnapshot([
      { id: approvedAvatar.id, included: true, available: enabled }, { id: 'another-live-effect', included: true, available: true }]),
    generate: async () => { generations++; } };
  const { page } = createPage(client);
  await page.onLoad({ effectId: approvedAvatar.id });
  assert.equal(page.data.effectAvailable, true);
  enabled = false; await page.refresh(); await page.generate();
  assert.equal(page.data.effectId, approvedAvatar.id);
  assert.equal(page.data.effectAvailable, false);
  assert.equal(generations, 0);
});

test('native route retains one in-flight submission and removes private state after account change', async () => {
  let generations = 0, rejectJob;
  const client = { entitlements: async () => ({ available: { photo: 10 } }), refresh: async () => pageSnapshot(),
    generate: () => { generations++; return new Promise((_resolve, reject) => { rejectJob = reject; }); } };
  const { page } = createPage(client);
  await page.onLoad({ effectId: approvedAvatar.id });
  Object.assign(page.data, { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self',
    selectedPhoto: '/fictional/private.png', works: [{ assetId: 'privateA' }], result: { assetId: 'privateA' } });
  const first = page.generate();
  await page.generate();
  assert.equal(generations, 1);
  rejectJob(Object.assign(new Error('account changed'), { code: 'XPAY_ACCOUNT_CHANGED' }));
  await first;
  assert.equal(page.photoData, null);
  assert.equal(page.data.selectedPhoto, '');
  assert.equal(page.data.works.length, 0);
  assert.equal(page.data.result, null);
  assert.equal(page.data.photo, null);
  assert.equal(page.data.faceAgreed, false);
  assert.equal(page.data.available, false);
  assert.equal(page.data.effectAvailable, false);
  assert.match(page.data.notice, /账号已变化/);
});

test('only supported local views scroll to their fixed sections', async () => {
  for (const [view, selector] of [['works', '#my-works'], ['privacy', '#photo-consent'], ['untrusted-selector', null]]) {
    const { page, scrolls } = createPage({ entitlements: async () => ({ available: { photo: 10 } }), refresh: async () => pageSnapshot() });
    await page.onLoad({ view });
    assert.equal(scrolls.length, selector ? 1 : 0);
    if (selector) assert.equal(scrolls[0].selector, selector);
  }
});
