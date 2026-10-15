import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
const { prepareLocalPhoto } = createRequire(import.meta.url)('../../miniprogram/photo-input.js');

const pageSource = readFileSync(new URL('../../miniprogram/pages/create/index.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../../miniprogram/pages/create/index.wxml', import.meta.url), 'utf8');
const ids = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
const makeSnapshot = () => ({ available: true, photo: 2, effects: ids.map(id => ({ id, title: id, included: true, available: true })),
  compliance: { consentVersions: { basic: 'basic-v1', faceProcessing: 'face-v1' }, retention: { sourceHours: 24, resultHours: 24 } },
  services: [], works: [], pending: false });

function fixture(overrides = {}) {
  let page;
  const snapshot = makeSnapshot(), events = [], timers = new Map();
  const client = { setActive: active => events.push(['active', active]),
    entitlements: async () => ({ available: { photo: snapshot.photo } }), refresh: async () => snapshot,
    generate: async (request, stage) => { events.push(['generate', request]); stage('uploading'); return { pending: true, job: { state: 'queued' } }; },
    saveAsset: async id => events.push(['save', id]), ...overrides };
  const wx = {
    getPrivacySetting: options => options.success({ needAuthorization: false }),
    requirePrivacyAuthorize: options => options.success({}),
    chooseMedia: options => { events.push(['picker', options.sourceType]); options.success({ tempFiles: [{ tempFilePath: '/fictional/photo.png', size: 10 }] }); },
    getImageInfo: options => options.success({ type: 'png', width: 400, height: 500 }),
    getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: 5 }), readFile: options => options.success({ data: 'aGVsbG8=' }) }),
    showToast: options => events.push(['toast', options.title]),
    pageScrollTo: options => events.push(['scroll', options]), navigateTo: options => events.push(['navigate', options.url]),
    switchTab: options => events.push(['tab', options.url]),
    requestVirtualPayment: () => assert.fail('product navigation must never make payment calls'),
  };
  runInNewContext(pageSource, { Page: value => { page = value; }, wx,
    getApp: () => ({ globalData: { creationEnabled: true, apiTransport: {} } }),
    require: name => { if (name === '../../photo-input') return { prepareLocalPhoto }; assert.equal(name, '../../creation'); return { createCreationClient: () => client, imageLimit: 2 * 1024 * 1024 }; },
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) });
  page.data = structuredClone(page.data); page.setData = patch => Object.assign(page.data, patch);
  return { page, client, wx, events, snapshot, timers };
}
const agree = page => {
  page.basicChanged({ detail: { value: ['basic'] } });
  page.authorizationChanged({ detail: { value: 'self' } });
  page.faceChanged({ detail: { value: ['face'] } });
};

test('each selected effect stays locked through local selection, separate authorization and one submission', async () => {
  for (const id of ids) {
    const f = fixture(); await f.page.onLoad({ effectId: id });
    assert.equal(f.page.data.flowView, 'upload');
    assert.equal(f.page.data.effectId, id);
    assert.ok(existsSync(new URL(`../../miniprogram${f.page.data.effectPreview}`, import.meta.url)));
    f.page.chooseEffect({ currentTarget: { dataset: { id: ids.find(item => item !== id) } } });
    assert.equal(f.page.data.effectId, id);
    await f.page.selectPhoto(); f.page.continueToConsent();
    assert.equal(f.page.data.flowView, 'consent');
    assert.equal(f.events.some(event => event[0] === 'generate'), false);
    await f.page.generate(); assert.equal(f.events.some(event => event[0] === 'generate'), false);
    agree(f.page); await f.page.generate();
    const generations = f.events.filter(event => event[0] === 'generate');
    assert.equal(generations.length, 1); assert.equal(generations[0][1].effectId, id);
    assert.equal(generations[0][1].consent.basicVersion, 'basic-v1');
  }
});

test('camera and album are local previews and replacing a photo invalidates all creation agreements', async () => {
  const f = fixture(); await f.page.onLoad({ effectId: ids[0] });
  await f.page.selectPhoto({ currentTarget: { dataset: { source: 'camera' } } });
  agree(f.page); f.page.continueToConsent();
  await f.page.selectPhoto({ currentTarget: { dataset: { source: 'album' } } });
  assert.equal(f.page.data.flowView, 'upload');
  assert.equal(f.page.data.basicAgreed, false); assert.equal(f.page.data.faceAgreed, false);
  assert.equal(f.page.data.subjectAuthorization, '');
  assert.deepEqual(f.events.filter(event => event[0] === 'picker').map(event => Array.from(event[1])), [['camera'], ['album']]);
  assert.equal(f.events.some(event => event[0] === 'generate'), false);
});

test('zero balance shows a purchase path without generating or buying; stale balance rejection returns to upload', async () => {
  const f = fixture(); f.snapshot.photo = 0; await f.page.onLoad({ effectId: ids[0] });
  await f.page.selectPhoto(); agree(f.page); f.page.continueToConsent(); await f.page.generate();
  assert.equal(f.page.data.flowView, 'upload'); assert.match(f.page.data.status, /次数不足/);
  assert.equal(f.events.some(event => event[0] === 'generate'), false);
  f.page.openPayments(); assert.deepEqual(f.events.filter(event => event[0] === 'navigate'), [['navigate', '/pages/payments/index?returnTo=creation&effectId=natural-avatar']]);
  const stale = fixture({ generate: async () => { throw Object.assign(new Error('次数不足，请查看套餐'), { code: 'INSUFFICIENT_ENTITLEMENT' }); } });
  await stale.page.onLoad({ effectId: ids[0] }); await stale.page.selectPhoto(); agree(stale.page);
  await stale.page.generate(); assert.equal(stale.page.data.photo, 0); assert.equal(stale.page.data.flowView, 'upload');
  assert.equal(stale.events.some(event => event[0] === 'navigate'), false);
});

test('pending stage has its own view and repeated taps, restart and clear cannot release the original task', async () => {
  let release, stage;
  const f = fixture({ generate: (request, onStage) => { stage = onStage; f.events.push(['generate', request]); return new Promise(resolve => { release = resolve; }); } });
  await f.page.onLoad({ effectId: ids[1] }); await f.page.selectPhoto(); agree(f.page);
  const running = f.page.generate(); assert.equal(f.page.data.flowView, 'processing');
  stage('uploading'); assert.equal(f.page.data.status, '正在上传照片');
  await f.page.generate(); assert.equal(f.events.filter(event => event[0] === 'generate').length, 1);
  f.snapshot.pending = true; f.snapshot.job = { state: 'queued' }; release({ pending: true, job: { state: 'queued' } }); await running;
  assert.equal(f.page.data.flowView, 'processing'); assert.equal(f.page.data.pending, true);
  const photo = f.page.photoData; f.page.clearPhoto(); f.page.restartCreation();
  assert.equal(f.page.photoData, photo); assert.equal(f.page.data.flowView, 'processing');
  f.page.openWorks(); assert.equal(f.page.data.flowView, 'works'); f.page.closeWorks(); assert.equal(f.page.data.flowView, 'processing');
});

test('verified completion opens result; save, works, restart and finish do not submit another generation', async () => {
  const f = fixture(); await f.page.onLoad({ effectId: ids[2] });
  f.snapshot.works = [{ assetId: 'result-1', createdAt: 1, url: 'https://example.test/fixture.png' }];
  f.snapshot.result = { ...f.snapshot.works[0], inputAssetId: 'input-1' };
  await f.page.refresh(); assert.equal(f.page.data.flowView, 'result');
  await f.page.saveWork({ currentTarget: { dataset: { id: 'result-1' } } });
  assert.equal(f.events.filter(event => event[0] === 'save').length, 1);
  f.page.openWorks(); assert.equal(f.page.data.flowView, 'works'); await f.page.refresh(); assert.equal(f.page.data.flowView, 'works');
  f.page.closeWorks(); assert.equal(f.page.data.flowView, 'result');
  f.page.restartCreation(); assert.equal(f.page.data.flowView, 'upload'); assert.equal(f.page.data.result, null);
  await f.page.refresh(); assert.equal(f.page.data.flowView, 'upload'); assert.equal(f.page.data.result, null);
  assert.equal(f.page.data.works.length, 1, 'restarting does not delete the completed work');
  f.page.finishCreation(); assert.equal(f.events.at(-1)[1], '/pages/photos/index');
  assert.equal(f.events.some(event => event[0] === 'generate'), false);
});

test('read-only works and privacy routes never become a creation view or submit', async () => {
  for (const view of ['works', 'privacy']) {
    const f = fixture(); await f.page.onLoad({ view });
    assert.equal(f.page.data.flowView, view); assert.equal(f.page.readOnly, true);
    await f.page.selectPhoto(); f.page.continueToConsent(); await f.page.generate(); f.page.restartCreation();
    assert.equal(f.page.data.flowView, view); assert.equal(f.events.some(event => event[0] === 'generate' || event[0] === 'picker'), false);
  }
});

test('a recovered earlier effect is not attributed to the currently selected card; restart only opens its empty photo step', async () => {
  const f = fixture();
  f.snapshot.pending = { effectId: 'natural-avatar', jobId: 'prior-avatar-job' };
  f.snapshot.job = { id: 'prior-avatar-job', state: 'queued', effectId: 'natural-avatar', effectSource: 'account-pending' };
  await f.page.onLoad({ effectId: 'modern-comic' });
  assert.equal(f.page.data.effectId, 'modern-comic'); assert.equal(f.page.data.flowView, 'processing');
  assert.equal(f.page.data.processingTitle, '自然 AI 头像 · 制作中'); assert.equal(f.page.data.processingDifferentEffect, true);
  f.snapshot.pending = null; f.snapshot.job = { id: 'prior-avatar-job', state: 'succeeded', assetId: 'prior-avatar-result' };
  f.snapshot.works = [{ assetId: 'prior-avatar-result', createdAt: 1 }];
  f.snapshot.result = { assetId: 'prior-avatar-result', url: 'https://example.test/prior-avatar.png', inputAssetId: 'prior-input',
    effectId: 'natural-avatar', effectSource: 'account-pending' };
  await f.page.refresh();
  assert.equal(f.page.data.flowView, 'result'); assert.equal(f.page.data.result.assetId, 'prior-avatar-result');
  assert.equal(f.page.data.resultTitle, '自然 AI 头像'); assert.equal(f.page.data.effectId, 'modern-comic');
  assert.equal(f.page.data.resultEffectId, 'natural-avatar');
  assert.match(markup, /flowView === 'result' \? resultTitle/); assert.match(markup, /这是上次“\{\{resultTitle\}\}”的作品/);
  assert.doesNotMatch(markup, /记录未提供|缺归属/);
  f.page.openWorks(); f.page.closeWorks(); assert.equal(f.page.data.resultTitle, '自然 AI 头像');
  f.page.restartCreation();
  assert.equal(f.page.data.flowView, 'upload'); assert.equal(f.page.data.effectId, 'modern-comic');
  assert.equal(f.page.data.selectedPhoto, ''); assert.equal(f.page.photoData, null);
  assert.equal(f.page.data.basicAgreed, false); assert.equal(f.page.data.faceAgreed, false);
  assert.equal(f.page.data.subjectAuthorization, ''); assert.equal(f.page.data.result, null);
  await f.page.refresh(); assert.equal(f.page.data.flowView, 'upload'); assert.equal(f.page.data.works.length, 1);
  await f.page.generate();
  assert.equal(f.events.some(event => event[0] === 'generate' || event[0] === 'picker' || event[0] === 'navigate'), false);
});

test('a normal new task uses its own processing and result title, while unknown old metadata stays neutral', async () => {
  const f = fixture({ generate: async () => {
    f.snapshot.pending = null; f.snapshot.job = { id: 'current-job', state: 'succeeded' };
    f.snapshot.works = [{ assetId: 'current-result', createdAt: 1 }];
    f.snapshot.result = { assetId: 'current-result', url: 'https://example.test/current.png',
      effectId: 'gentle-watercolor', effectSource: 'account-pending' };
    return { pending: false, job: f.snapshot.job };
  } });
  await f.page.onLoad({ effectId: 'gentle-watercolor' }); await f.page.selectPhoto(); agree(f.page);
  const running = f.page.generate(); assert.equal(f.page.data.processingTitle, '正在制作'); await running;
  assert.equal(f.page.data.resultTitle, '温润水彩像'); assert.equal(f.page.data.resultEffectId, 'gentle-watercolor');
  assert.equal(f.page.data.effectId, 'gentle-watercolor');
  for (const metadata of [{}, { effectId: 'natural-avatar' }, { effectId: 'unknown', effectSource: 'account-pending' },
    { effectId: 'natural-avatar', effectSource: 'guessed' }]) {
    const old = fixture(); old.snapshot.works = [{ assetId: 'old-result', createdAt: 1 }];
    old.snapshot.result = { assetId: 'old-result', url: 'https://example.test/old.png', ...metadata };
    await old.page.onLoad({ effectId: 'modern-comic' });
    assert.equal(old.page.data.resultTitle, '上次制作的作品'); assert.equal(old.page.data.resultEffectId, '');
    assert.equal(old.page.data.effectId, 'modern-comic');
  }
});

test('late stage and success callbacks after hiding cannot restore source, status or result', async () => {
  let release, stage;
  const f = fixture({ generate: (request, onStage) => { stage = onStage; return new Promise(resolve => { release = resolve; }); } });
  await f.page.onLoad({ effectId: ids[0] }); await f.page.selectPhoto(); agree(f.page);
  const running = f.page.generate(); f.page.onHide(); const status = f.page.data.status;
  stage('generating'); release({ pending: false, result: { assetId: 'late' } }); await running;
  assert.equal(f.page.data.flowView, 'upload'); assert.equal(f.page.data.selectedPhoto, '');
  assert.equal(f.page.photoData, null); assert.equal(f.page.data.result, null); assert.equal(f.page.data.status, status);
});

test('unconfirmed responses stay in processing, without fabricating completion or a percentage', async () => {
  const f = fixture({ generate: async () => { throw Object.assign(new Error('原任务待核实'), { code: 'CREATION_UNCONFIRMED' }); } });
  await f.page.onLoad({ effectId: ids[0] }); await f.page.selectPhoto(); agree(f.page); await f.page.generate();
  assert.equal(f.page.data.pending, true); assert.equal(f.page.data.flowView, 'processing'); assert.equal(f.page.data.result, null);
  assert.doesNotMatch(markup, /\{\{[^}]*percent|\{\{[^}]*progress|bindtap="chooseEffect"|wx:for="\{\{effects\}\}"/i);
});

test('returning before a submit reply recovers its durable record, without repainting late source or replaying submit', async () => {
  let release, submissions = 0;
  const f = fixture({ generate: () => { submissions++; return new Promise(resolve => { release = resolve; }); } });
  await f.page.onLoad({ effectId: ids[0] }); await f.page.selectPhoto(); agree(f.page);
  const running = f.page.generate(); f.page.onHide(); await f.page.onShow();
  f.snapshot.pending = true; f.snapshot.job = { state: 'queued' };
  release({ pending: true, job: { state: 'queued' } }); await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submissions, 1); assert.equal(f.page.data.flowView, 'processing');
  assert.equal(f.page.data.selectedPhoto, ''); assert.equal(f.page.data.pending, true);
});

test('template has balanced tags and all handlers exist; result images preserve the full image', () => {
  const f = fixture(), stack = [];
  for (const match of markup.matchAll(/<\/?([\w-]+)\b[^>]*>/g)) {
    const [token, tag] = match;
    if (token.startsWith('</')) assert.equal(stack.pop(), tag, token);
    else if (!token.endsWith('/>')) stack.push(tag);
  }
  assert.deepEqual(stack, []);
  for (const match of markup.matchAll(/\b(?:bindtap|bindchange|bindagreeprivacyauthorization)="([\w]+)"/g)) assert.equal(typeof f.page[match[1]], 'function', match[1]);
  for (const match of markup.matchAll(/<image\b[^>]*src="\{\{(?:result|item)\.url\}\}"[^>]*>/g)) assert.match(match[0], /mode="aspectFit"/);
  assert.match(markup, /本次制作使用 1 次图片次数/); assert.match(markup, /图片次数不足/); assert.match(markup, /查看套餐/);
});
