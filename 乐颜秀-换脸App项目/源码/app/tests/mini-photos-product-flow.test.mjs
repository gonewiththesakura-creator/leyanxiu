import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../miniprogram/pages/photos/index.js', import.meta.url), 'utf8');
const adapters = require('../miniprogram/business-adapters');
const catalog = require('../miniprogram/catalog/effects');
const ids = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
function setup({ snapshot, privacy, refresh } = {}) {
  const data = snapshot || { available: true, effects: ids.map(id => ({ id, available: true, included: true })) };
  let page, reads = 0, privacies = 0, clients = 0;
  const nav = [], toasts = [];
  const wx = { getWindowInfo: () => ({ statusBarHeight: 24 }), showToast: x => toasts.push(x.title), navigateTo: x => nav.push(x) };
  const client = { setActive: () => {}, refresh: async () => { reads++; return refresh ? refresh() : data; } };
  runInNewContext(source, { wx, getApp: () => ({ globalData: { creationEnabled: true } }),
    Page: x => { page = x; }, require: name => name.includes('catalog') ? catalog : name.includes('business-adapters') ? adapters
      : name.includes('privacy-consent') ? { privacyMethods: { nativePrivacy: async () => { privacies++; if (privacy) await privacy(); }, cancelNativePrivacy() {} } }
        : { createCreationClient: () => { clients++; return client; } } });
  page.data = structuredClone(page.data); page.setData = x => Object.assign(page.data, x); page.onLoad(); page.onShow();
  return { page, nav, toasts, wx, reads: () => reads, privacies: () => privacies, clients: () => clients };
}
const card = id => ({ currentTarget: { dataset: { id } } });
test('each integrated card connects on tap and navigates to its exact selection without a separate check button', async () => {
  for (const id of ids) {
    const f = setup(); f.page.selectCategory(card('art'));
    assert.equal(f.page.data.effects.find(row => row.id === id).availabilityLabel, '选择效果');
    assert.equal(f.reads(), 0); await f.page.openEffect(card(id));
    assert.equal(f.reads(), 1); assert.equal(f.privacies(), 1);
    assert.equal(f.nav.length, 1); assert.equal(f.nav[0].url, '/pages/create/index?effectId=' + id);
    await f.page.openEffect(card(id)); assert.equal(f.nav.length, 1);
  }
});
test('unsupported and unknown cards never connect an account or substitute another effect', async () => {
  const f = setup();
  for (const id of ['age-change', 'classic-black-white', 'fake', '__proto__']) await f.page.openEffect(card(id));
  assert.equal(f.nav.length, 0); assert.equal(f.privacies(), 0); assert.equal(f.clients(), 0);
});
test('privacy rejection and a failed service read keep navigation closed but allow a fresh retry', async () => {
  let rejected = true;
  const f = setup({ privacy: () => { if (rejected) throw new Error('已取消'); } });
  await f.page.openEffect(card(ids[0])); assert.equal(f.nav.length, 0); assert.equal(f.clients(), 0);
  rejected = false; await f.page.openEffect(card(ids[0])); assert.equal(f.nav.length, 1);
  let failed = true;
  const g = setup({ refresh: () => { if (failed) throw new Error('未连接'); return { available: true, effects: [{ id: ids[1], included: true, available: true }] }; } });
  await g.page.openEffect(card(ids[1])); assert.equal(g.nav.length, 0);
  failed = false; await g.page.openEffect(card(ids[1])); assert.equal(g.nav.length, 1);
});
test('duplicate, missing, nonincluded and unavailable selected effects never navigate', async () => {
  for (const effects of [[], [{ id: ids[0], included: false, available: true }],
    [{ id: ids[0], included: true, available: false }],
    [0, 1].map(() => ({ id: ids[0], included: true, available: true }))]) {
    const f = setup({ snapshot: { available: true, effects } });
    await f.page.openEffect(card(ids[0])); assert.equal(f.nav.length, 0);
  }
});
test('double tap and leave-return during a slow lookup cannot navigate using the abandoned response', async () => {
  let release;
  const f = setup({ refresh: () => new Promise(resolve => { release = resolve; }) });
  const first = f.page.openEffect(card(ids[0]));
  await new Promise(resolve => setImmediate(resolve));
  await f.page.openEffect(card(ids[1])); assert.equal(f.reads(), 1);
  f.page.onHide(); f.page.onShow();
  release({ available: true, effects: ids.map(id => ({ id, included: true, available: true })) });
  await first; assert.equal(f.nav.length, 0); assert.equal(f.page.data.connected, false);
});
test('navigation failure releases the tap lock; manual refresh never opens a page', async () => {
  const f = setup(); await f.page.checkAvailability(); assert.equal(f.nav.length, 0);
  await f.page.openEffect(card(ids[0])); f.nav[0].fail();
  await f.page.openEffect(card(ids[1])); assert.equal(f.nav.length, 2); assert.equal(f.reads(), 1);
});
