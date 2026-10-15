// Browsing-only acceptance through the installed official WeChat IDE.
// Never connects an account, buys a product, uploads a photo or starts a job.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { officialCommand } from '../server/scripts/probe-mini-closed-client.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'miniprogram');
const output = path.join(root, 'output/native-product-20261014');
fs.mkdirSync(output, { recursive: true });
const steps = [];
async function call(tool, flags = []) {
  const command = officialCommand(tool, ['--project', project, ...flags]);
  const response = await promisify(execFile)(command.executable, command.args, command.options);
  const envelope = JSON.parse(response.stdout);
  assert.equal(envelope.ok, true, tool);
  assert.equal(envelope.result?.success, true, tool + ' result');
  return envelope.result;
}
async function state() {
  const r = await call('automation_evaluate', ['--fnSource', 'function(){var p=getCurrentPages().slice(-1)[0];var d=p.data;return {route:p.route,category:d.categoryId||d.category,current:d.current,muted:d.muted,mediaReady:d.mediaReady,previewFailed:d.previewFailed,template:d.templates&&d.templates[d.current||0]&&d.templates[d.current||0].id,count:d.effects?d.effects.length:d.templates?d.templates.length:0,connected:d.connected,hasClient:!!p.client};}']);
  return r.result.result;
}
async function navigate(page) {
  await call('automation_navigate', ['--action', 'switchTab', '--url', `/pages/${page}/index`]);
  assert.equal((await state()).route, `pages/${page}/index`);
}
async function tap(selector) { await call('automation_element_action', ['--action', 'tap', '--selector', selector]); }
async function capture(page, name = page) {
  assert.equal((await state()).route, `pages/${page}/index`);
  await call('simulator_screenshot', ['--path', path.join(output, `${name}.png`), '--optimize', 'false', '--wait', '1']);
  assert.equal((await state()).route, `pages/${page}/index`);
}
try {
  await navigate('home'); await capture('home');
  await tap('.category[data-category="经典精选"]');
  assert.equal((await state()).category, '经典精选');
  steps.push({ check: 'home-category', passed: true });
  await navigate('songs'); await capture('songs');
  await tap('.category[data-category="经典台词"]');
  assert.equal((await state()).count, 1);
  steps.push({ check: 'songs-category', passed: true });
  // All four original video sources must emit the native video play event.
  for (const id of ['quote', 'dance', 'street', 'jinqu']) {
    await navigate('songs');
    await tap('.category[data-category="热门"]');
    await tap(`.card[data-id="${id}"]`);
    let snapshot;
    for (let attempt = 0; attempt < 12; attempt++) {
      snapshot = await state();
      if (snapshot.mediaReady || snapshot.previewFailed) break;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    assert.equal(snapshot.route, 'pages/featured/index');
    assert.equal(snapshot.template, id);
    assert.equal(snapshot.previewFailed, false);
    assert.equal(snapshot.mediaReady, true, id + ' must actually play');
    steps.push({ check: 'native-video-play', template: id, passed: true });
    if (id === 'quote') {
      await tap('.sound'); assert.equal((await state()).muted, false);
      await tap('.sound'); assert.equal((await state()).muted, true);
      await capture('featured');
      steps.push({ check: 'native-video-mute-toggle', passed: true });
    }
  }
  await navigate('photos'); await capture('photos');
  for (const [id, count] of [['culture', 4], ['art', 5], ['restore', 4], ['time', 4]]) {
    await tap(`.category-card[data-id="${id}"]`);
    const snapshot = await state();
    assert.equal(snapshot.category, id); assert.equal(snapshot.count, count);
    assert.equal(snapshot.connected, false); assert.equal(snapshot.hasClient, false);
    steps.push({ check: 'photo-category-no-account', category: id, count, passed: true });
  }
  await tap('.effect-card[data-id="age-change"]');
  assert.equal((await state()).route, 'pages/photos/index');
  assert.equal((await state()).hasClient, false);
  steps.push({ check: 'unavailable-effect-no-job-or-account', passed: true });
  await navigate('mine');
  assert.equal((await state()).connected, false); assert.equal((await state()).hasClient, false);
  await capture('mine');
  steps.push({ check: 'mine-browsing-no-account', passed: true });
  const report = { ok: true, verifiedAt: new Date().toISOString(), environment: 'official-wechat-ide-simulator', steps, livePayment: false, providerGeneration: false, handsetVerified: false, uploaded: false };
  fs.writeFileSync(path.join(output, 'runtime-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  fs.writeFileSync(path.join(output, 'runtime-check.json'), JSON.stringify({ ok: false, steps, error: error.message }, null, 2) + '\n');
  console.error(JSON.stringify({ ok: false, completed: steps, error: error.message }));
  process.exitCode = 1;
}
