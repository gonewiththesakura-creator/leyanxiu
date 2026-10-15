import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../miniprogram/preview-media/components/player/index.js', import.meta.url), 'utf8');
const files = ['dance-preview-r12.mp4', 'quote-preview-r12.mp4', 'night-song-preview-r9.mp4', 'classic-song-preview-r9.mp4'];
function player(src = '/preview-media/templates/' + files[0], active = true) {
  let definition;
  const copies = [], writes = [], events = [], pauses = [], plays = [], ticks = [];
  const wx = {
    env: { USER_DATA_PATH: '/local-user-cache' },
    getFileSystemManager: () => ({ copyFile: operation => copies.push(operation) }),
    nextTick: callback => ticks.push(callback),
    createVideoContext: (id, instance) => ({ pause: () => pauses.push({ id, instance }), play: () => plays.push({ id, instance, mediaSrc: instance.data.mediaSrc }) }),
  };
  runInNewContext(source, { Component: value => { definition = value; }, wx });
  const instance = { properties: { src, poster: '/cover.webp', muted: true, active }, data: { mediaSrc: '' },
    setData(value, callback) { Object.assign(this.data, value); writes.push({ ...value }); callback?.(); },
    triggerEvent(name, detail) { events.push({ name, detail }); }, ...definition.methods };
  return { definition, instance, copies, writes, events, pauses, plays, ticks,
    attach() { definition.lifetimes.attached.call(instance); },
    detach() { definition.lifetimes.detached.call(instance); },
    hide() { definition.pageLifetimes.hide.call(instance); },
    activate(value) { instance.properties.active = value; definition.properties.active.observer.call(instance, value); },
    flushTicks() { while (ticks.length) ticks.shift()(); } };
}

test('each of exactly four packaged demos copies to a fixed bounded local cache filename', () => {
  for (const filename of files) {
    assert.ok(existsSync(new URL('../../miniprogram/preview-media/templates/' + filename, import.meta.url)), filename);
    const f = player('/preview-media/templates/' + filename); f.attach();
    assert.equal(f.copies.length, 1);
    assert.equal(f.copies[0].srcPath, '/preview-media/templates/' + filename);
    assert.equal(f.copies[0].destPath, '/local-user-cache/lyx-preview-' + filename);
    assert.equal(f.instance.data.mediaSrc, '');
    f.copies[0].success();
    assert.equal(f.instance.data.mediaSrc, f.copies[0].destPath);
    assert.equal(f.events.length, 0);
  }
});

test('source whitelist rejects remote, traversal, query, private and unknown filenames before filesystem access', () => {
  for (const src of ['', files[0], 'https://example.test/' + files[0], '/tmp/' + files[0],
    '/preview-media/templates/../templates/' + files[0], '/preview-media/templates/' + files[0] + '?token=REDACTED_SECRET
    '/preview-media/templates/private-user.mp4', '/preview-media/templates/constructor']) {
    const f = player(src); f.attach();
    assert.equal(f.copies.length, 0, src);
    assert.equal(f.instance.data.mediaSrc, '', src);
    assert.equal(f.events[0]?.name, 'previewerror', src);
    assert.equal(f.events[0]?.detail.errMsg, 'UNKNOWN_PREVIEW', src);
  }
});

test('copy failure retains the poster with no playable media and reports a bounded error', () => {
  const f = player(); f.attach(); f.copies[0].fail({ errMsg: 'private-file-details' });
  assert.equal(f.instance.data.mediaSrc, '');
  assert.equal(f.events[0].name, 'previewerror');
  assert.equal(f.events[0].detail.errMsg, 'PREVIEW_CACHE_UNAVAILABLE');
});

test('source changes invalidate old successful and failed copy callbacks', () => {
  const f = player(); f.attach();
  const first = f.copies[0];
  f.instance.properties.src = '/preview-media/templates/' + files[1];
  f.definition.properties.src.observer.call(f.instance);
  first.success(); first.fail();
  assert.equal(f.instance.data.mediaSrc, '');
  assert.equal(f.events.length, 0);
  f.copies[1].success();
  assert.equal(f.instance.data.mediaSrc, '/local-user-cache/lyx-preview-' + files[1]);
});

test('detachment cancels late copy success and error callbacks and pauses the native video', () => {
  const f = player(); f.attach(); f.detach();
  const writeCount = f.writes.length;
  f.copies[0].success(); f.copies[0].fail();
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.events.length, 0);
  assert.equal(f.pauses.length, 1);
  assert.equal(f.pauses[0].id, 'preview');
  assert.equal(f.pauses[0].instance, f.instance);
});

test('page hide prevents late media-copy callbacks from restarting playback', () => {
  const f = player(); f.attach(); f.hide();
  const writeCount = f.writes.length;
  f.copies[0].success(); f.copies[0].fail();
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.events.length, 0);
  assert.equal(f.instance.data.mediaSrc, '');
  assert.equal(f.pauses.length, 1);
});

test('play and video error events relay preview state without contacting any service', () => {
  const f = player(); f.attach(); f.instance.played(); f.instance.failed({ detail: { errMsg: 'decode-failed' } });
  assert.equal(f.events[0].name, 'previewplay');
  assert.equal(f.events[1].name, 'previewerror');
  assert.equal(f.events[1].detail.errMsg, 'decode-failed');
});

test('hidden playback events stay silent and page show prepares only the current public demo', () => {
  const f = player(); f.attach(); f.hide();
  f.instance.played(); f.instance.failed({ detail: { errMsg: 'late-error' } });
  assert.equal(f.events.length, 0);
  f.instance.properties.src = '/preview-media/templates/' + files[2];
  f.definition.pageLifetimes.show.call(f.instance);
  assert.equal(f.copies.length, 2);
  assert.equal(f.copies[1].srcPath, f.instance.properties.src);
  f.copies[0].success(); assert.equal(f.instance.data.mediaSrc, '');
  f.copies[1].success(); assert.equal(f.instance.data.mediaSrc, '/local-user-cache/lyx-preview-' + files[2]);
  f.instance.played(); assert.equal(f.events[0].name, 'previewplay');
});

test('inactive public players never copy or emit playback state on attach, show or source updates', () => {
  const f = player('/preview-media/templates/' + files[0], false); f.attach();
  f.definition.pageLifetimes.show.call(f.instance);
  f.instance.properties.src = '/preview-media/templates/' + files[1];
  f.definition.properties.src.observer.call(f.instance);
  f.instance.played(); f.instance.failed({ detail: { errMsg: 'inactive-video' } });
  assert.equal(f.copies.length, 0);
  assert.equal(f.instance.data.mediaSrc, '');
  assert.equal(f.events.length, 0);
});

test('deactivation pauses and clears playback while invalidating every pending copy callback', () => {
  const f = player(); f.attach(); const first = f.copies[0];
  f.activate(false);
  const writeCount = f.writes.length;
  first.success(); first.fail(); f.instance.played(); f.instance.failed({ detail: { errMsg: 'late-video' } });
  assert.equal(f.instance.data.mediaSrc, '');
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.events.length, 0);
  assert.equal(f.pauses.length, 1);
  f.activate(true);
  assert.equal(f.copies.length, 2);
  first.success(); assert.equal(f.instance.data.mediaSrc, '');
  f.copies[1].success(); assert.equal(f.instance.data.mediaSrc, '/local-user-cache/lyx-preview-' + files[0]);
});

test('current media resumes explicitly after copy and metadata instead of relying solely on autoplay', () => {
  const f = player(); f.attach(); f.copies[0].success();
  assert.equal(f.plays.length, 0);
  assert.equal(f.ticks.length, 1);
  f.flushTicks();
  assert.equal(f.plays.length, 1);
  assert.equal(f.plays[0].id, 'preview');
  assert.equal(f.plays[0].instance, f.instance);
  assert.equal(f.plays[0].mediaSrc, '/local-user-cache/lyx-preview-' + files[0]);
  f.instance.resume(); f.flushTicks(); assert.equal(f.plays.length, 2);
});

test('queued resume cannot play detached, hidden, inactive, empty or replaced media', () => {
  for (const stop of [f => f.detach(), f => f.hide(), f => f.activate(false),
    f => f.instance.setData({ mediaSrc: '' }),
    f => { f.instance.properties.src = '/preview-media/templates/' + files[1]; f.definition.properties.src.observer.call(f.instance); }]) {
    const f = player(); f.attach(); f.copies[0].success();
    assert.equal(f.ticks.length, 1); stop(f); f.flushTicks();
    assert.equal(f.plays.length, 0);
  }
});

test('old resume tick cannot start reactivated media while the new revision still can', () => {
  const f = player(); f.attach(); f.copies[0].success();
  f.activate(false); f.activate(true); f.copies[1].success();
  assert.equal(f.ticks.length, 2); f.flushTicks();
  assert.equal(f.plays.length, 1);
  assert.equal(f.plays[0].mediaSrc, '/local-user-cache/lyx-preview-' + files[0]);
});

function featured() {
  let definition;
  const app = { globalData: { previewTemplateId: 'quote' } }, pauses = [], writes = [], resumes = [];
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/featured/index.js', import.meta.url), 'utf8'), {
    require: id => require(fileURLToPath(new URL('../../miniprogram/pages/featured/' + id, import.meta.url))),
    Page: value => { definition = value; }, getApp: () => app,
    wx: { getWindowInfo: () => ({ statusBarHeight: 24 }), getMenuButtonBoundingClientRect: () => ({ bottom: 56 }), showToast() {} },
  });
  definition.data = JSON.parse(JSON.stringify(definition.data));
  definition.setData = value => { Object.assign(definition.data, value); writes.push(value); };
  definition.selectAllComponents = selector => {
    assert.equal(selector, '.preview');
    return files.map(filename => ({ pause: () => pauses.push(filename) }));
  };
  definition.selectComponent = selector => ({ resume: () => resumes.push(selector) });
  return { page: definition, app, pauses, writes, resumes };
}

test('featured hide pauses its async component, suppresses late play state and keeps creation unavailable', () => {
  const { page, app, pauses } = featured(); page.onLoad(); page.onShow();
  assert.equal(page.data.templates[page.data.current].id, 'quote');
  assert.equal(app.globalData.previewTemplateId, undefined);
  page.previewPlayed(); assert.equal(page.data.mediaReady, true);
  page.onHide(); assert.equal(page.data.visible, false); assert.equal(pauses.length, 4);
  assert.equal(new Set(pauses).size, 4);
  page.setData({ mediaReady: false }); page.previewPlayed(); assert.equal(page.data.mediaReady, false);
  page.onShow(); assert.equal(page.data.mediaReady, false); assert.equal(page.data.previewFailed, false);
  page.previewError({ detail: { errMsg: 'unavailable' } }); assert.equal(page.data.previewFailed, true);
  assert.ok(page.data.templates.every(template => template.canCreate === false));
});

test('programmatic duplicate swiper changes never pause the newly selected preview', () => {
  const { page, pauses } = featured(); page.onLoad(); page.onShow(); page.previewPlayed();
  const selected = page.data.current;
  page.changed({ detail: { current: selected } });
  page.changed({ detail: { current: selected } });
  assert.equal(pauses.length, 0);
  assert.equal(page.data.current, selected);
  assert.equal(page.data.mediaReady, true);
  for (const current of [-1, page.data.templates.length, 0.5, undefined, '0', NaN]) {
    page.changed({ detail: { current } });
    assert.equal(page.data.current, selected);
    assert.equal(pauses.length, 0);
  }
  const next = (selected + 1) % page.data.templates.length;
  page.changed({ detail: { current: next } });
  assert.equal(pauses.length, 4);
  assert.equal(page.data.current, next);
  assert.equal(page.data.mediaReady, false);
  page.previewPlayed(); page.changed({ detail: { current: next } });
  assert.equal(pauses.length, 4);
  assert.equal(page.data.mediaReady, true);
});

test('swiper animation settle resumes only its current selected instance while the page is visible', () => {
  const { page, resumes } = featured(); page.onLoad(); page.onShow();
  page.previewSettled(); assert.equal(resumes[0], '#featured-preview-' + page.data.current);
  page.changed({ detail: { current: (page.data.current + 1) % page.data.templates.length } });
  page.previewSettled(); assert.equal(resumes[1], '#featured-preview-' + page.data.current);
  page.onHide(); page.previewSettled(); assert.equal(resumes.length, 2);
});
