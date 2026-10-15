// Local layout fixtures rendered by the official IDE. These do NOT attest
// provider generation, payment, account admission or handset functionality.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { officialCommand } from '../server/scripts/probe-mini-closed-client.mjs';
const root = path.resolve(import.meta.dirname, '..');
const project = path.join(root, 'miniprogram');
const output = path.join(root, 'output/mini-app-parity-20261015');
fs.mkdirSync(output, { recursive: true });
async function call(tool, flags = []) {
  const c = officialCommand(tool, ['--project', project, ...flags]);
  const envelope = JSON.parse((await promisify(execFile)(c.executable, c.args, c.options)).stdout);
  assert.equal(envelope.ok, true, tool); assert.equal(envelope.result?.success, true, tool);
  return envelope.result;
}
async function evaluate(fn) { return (await call('automation_evaluate', ['--fnSource', fn])).result.result; }
async function navigate(action, url) { await call('automation_navigate', ['--action', action, '--url', url]); }
async function capture(name) {
  await call('simulator_screenshot', ['--path', path.join(output, name + '.png'), '--optimize', 'false', '--wait', '1']);
  console.log('Captured local layout fixture: ' + name);
}
async function captureBottom(name) {
  await evaluate('function(){wx.pageScrollTo({scrollTop:10000,duration:0});return {scrolled:true};}');
  await capture(name);
  await evaluate('function(){wx.pageScrollTo({scrollTop:0,duration:0});return {scrolled:true};}');
}
const set = async data => evaluate('function(){var p=getCurrentPages().slice(-1)[0];p.cancelNativePrivacy&&p.cancelNativePrivacy();p.client&&p.client.setActive(false);p.client=null;p.setData(' + JSON.stringify(data) + ');return {route:p.route,flow:p.data.flowView||null,hasClient:!!p.client};}');
try {
  await call('open_project_window', ['--window-mode', 'fullMode']);
  await call('simulator_open_page', ['--page', 'pages/photos/index']);
  await new Promise(resolve => setTimeout(resolve, 3000));
  await navigate('switchTab', '/pages/photos/index');
  // An invalid endpoint fails construction before login/request. Fixtures
  // have no client, so taps cannot invoke a payment or creation operation.
  await evaluate('function(){var a=getApp();globalThis.__lyxVisualConfig={apiTransport:a.globalData.apiTransport,apiBase:a.globalData.apiBase};a.globalData.apiTransport={mode:"layout-fixture-disabled"};a.globalData.apiBase="";return {disabled:true};}');
  await call('automation_element_action', ['--action', 'tap', '--selector', '.category-card[data-id="art"]']);
  await capture('01-photo-catalog');
  await navigate('navigateTo', '/pages/create/index?effectId=modern-comic');
  const image = '/assets/effects/previews/modern-comic.webp';
  await set({ flowView: 'upload', effectTitle: '现代漫画像', effectSubtitle: '明快线条与自然色彩；AI 漫画的人物细节可能改变',
    effectPreview: image, readAccessReady: true, available: true, effectAvailable: true, photo: 0,
    notice: '', status: '', busy: false, pending: false, privacyVisible: false });
  await capture('02-select-photo-zero-balance');
  await captureBottom('02b-zero-balance-action');
  await set({ flowView: 'consent', selectedPhoto: image, photo: 1, basicVersion: '示例版本', faceVersion: '示例版本',
    operator: 'REDACTED_COMPANY_NAME', supplierText: '本地布局示例，未连接处理方', sourceHours: 24, resultHours: 24,
    basicAgreed: false, faceAgreed: false, subjectAuthorization: '' });
  await capture('03-separate-consent');
  await captureBottom('03b-consent-action');
  await set({ flowView: 'processing', pending: true, status: '正在处理照片，请稍候', processingTitle: '正在制作', jobEffectTitle: '现代漫画像' });
  await capture('04-processing-layout');
  await set({ flowView: 'result', pending: false, result: { assetId: 'layout-fixture', url: image, effectId: 'modern-comic' },
    resultTitle: '现代漫画像', resultEffectId: 'modern-comic', status: '' });
  await capture('05-result-layout');
  await captureBottom('05b-result-actions');
  await navigate('navigateTo', '/pages/payments/index?returnTo=creation&effectId=modern-comic');
  await set({ connected: true, connecting: false, loading: false, available: false, purchaseSupported: true, privacyVisible: false,
    photo: 0, video: 0, activeTab: 'plans', merchantTest: true, scopeVerified: true, notice: '本地布局示例 · 不可购买',
    includedEffects: [{ id: 'natural-avatar', title: '自然 AI 头像' }, { id: 'modern-comic', title: '现代漫画像' }, { id: 'gentle-watercolor', title: '温润水彩像' }],
    products: [{ id: 'photo10', name: '图片处理10次包', price: '9.90', rights: '图片 10 次', days: 365 }], orders: [] });
  await capture('06-payment-layout');
  await captureBottom('06b-payment-rules');
  await call('automation_element_action', ['--action', 'tap', '--selector', '.tab[data-tab="orders"]']);
  await capture('07-order-layout');
  fs.writeFileSync(path.join(output, 'visual-fixture-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
    kind: 'official-ide-local-layout-fixtures', payment: false, providerGeneration: false, realAccount: false,
    uploaded: false, handsetVerified: false, screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')) }, null, 2));
} finally {
  await navigate('switchTab', '/pages/photos/index').catch(() => {});
  await evaluate('function(){var a=getApp(),s=globalThis.__lyxVisualConfig;if(s){a.globalData.apiTransport=s.apiTransport;a.globalData.apiBase=s.apiBase;delete globalThis.__lyxVisualConfig;}return {restored:!!s};}').catch(() => {});
}
