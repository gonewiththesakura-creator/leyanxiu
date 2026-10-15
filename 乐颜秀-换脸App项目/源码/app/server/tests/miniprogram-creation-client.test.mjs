import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { createCreationClient, photoAvailability } = createRequire(import.meta.url)('../../miniprogram/creation.js');
const { prepareLocalPhoto } = createRequire(import.meta.url)('../../miniprogram/photo-input.js');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=';
const consent = { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', basicVersion: 'basic-v1', faceVersion: 'face-v1' };
function publicFacts() {
  return {
    catalog: { settings: { generationEnabled: true }, miniProgramCreation: { available: true, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: ['effect1'] },
      photoEffects: [{ id: 'effect1', title: '老照片修复', enabled: true }, { id: 'unreviewed', title: '其他效果', enabled: true }] },
    compliance: { status: 'approved', operatorName: 'Fictional Test Operator',
      consentVersions: { basic: 'basic-v1', faceProcessing: 'face-v1' },
      retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'Fictional deletion policy' },
      aiServices: [{ provider: 'fictional', model: 'test-photo', filingReference: 'fictional-reference',
        purpose: '用户图片处理', region: 'fictional', capabilities: ['photo-effect'] }] },
    capabilities: [{ id: 'photo-effects', ready: true, status: 'verified' }],
  };
}

async function fixture(t, { enabled = true, cloud = false, override, uploadState = 'ready', storage = new Map() } = {}) {
  const facts = publicFacts(), calls = [], transportCalls = [], stages = [], saved = [], removed = [];
  const works = [], jobs = new Map(), jobsByKey = new Map(), uploads = new Map(), uploadsByKey = new Map(); let authCalls = 0, nativePayments = 0, randomCalls = 0;
  const acceptUpload = call => {
    const uploadKey = call.headers['idempotency-key'];
    if (!uploadsByKey.has(uploadKey)) {
      const upload = { id: `upload_${(uploads.size + 1).toString(16).padStart(32, '0')}`, state: uploadState, createdAt: 1, updatedAt: 1,
        ...(uploadState === 'ready' ? { assetId: 'input1' } : {}) };
      uploads.set(upload.id, upload); uploadsByKey.set(uploadKey, upload.id);
    }
    return { ...uploads.get(uploadsByKey.get(uploadKey)) };
  };
  const acceptJob = call => {
    const idempotencyKey = call.headers['idempotency-key'];
    if (!jobsByKey.has(idempotencyKey)) {
      const job = { id: `job${jobs.size + 1}`, state: 'queued' };
      jobs.set(job.id, job); jobsByKey.set(idempotencyKey, job.id);
    }
    return { ...jobs.get(jobsByKey.get(idempotencyKey)) };
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const call = { path: req.url, method: req.method, headers: req.headers, data: text ? JSON.parse(text) : undefined };
    calls.push(call);
    const custom = await override?.(call, { facts, works, jobs, jobsByKey, acceptJob, uploads, uploadsByKey, acceptUpload, authCalls });
    if (custom?.drop) { req.socket.destroy(); return; }
    let data, code = 0, status = 200;
    if (custom) { data = custom.data; code = custom.code ?? 0; status = custom.status ?? 200; }
    else if (call.path === '/api/auth/wechat') { authCalls++; data = { token: `test-token-${authCalls}`, user: { id: 'buyer' } }; }
    else if (call.path === '/api/catalog') data = facts.catalog;
    else if (call.path === '/api/public/compliance') data = facts.compliance;
    else if (call.path === '/api/capabilities') data = facts.capabilities;
    else if (call.path === '/api/mini/payments/entitlements') data = { available: { photo: 4, video: 0 }, buckets: [] };
    else if (call.path === '/api/works') data = works;
    else if (call.path === '/api/consents' && call.method === 'GET') data = { current: { basic: 'basic-v1', face_processing: 'face-v1' }, entries: [] };
    else if (call.path === '/api/consents') data = { id: `consent-${calls.length}` };
    else if (call.path === '/api/mini/photo-uploads') { status = 202; data = { upload: acceptUpload(call), duplicate: false }; }
    else if (call.path.startsWith('/api/mini/photo-uploads/') && call.method === 'GET') {
      const byKey = call.path.startsWith('/api/mini/photo-uploads/by-key/');
      const reference = call.path.split('/').at(-1);
      const upload = uploads.get(byKey ? uploadsByKey.get(reference) : reference);
      data = { upload: upload ? { ...upload } : null };
    }
    else if (call.path === '/api/mini/photo-jobs' && call.method === 'POST') {
      status = 202; data = { job: acceptJob(call) };
    } else if (call.path.startsWith('/api/mini/photo-jobs/') && call.method === 'GET') {
      const byKey = call.path.startsWith('/api/mini/photo-jobs/by-key/');
      const reference = decodeURIComponent(call.path.split('/').at(-1));
      const job = jobs.get(byKey ? jobsByKey.get(reference) : reference);
      if (job) data = { job: { ...job } };
      else { status = 404; code = 'PHOTO_JOB_NOT_FOUND'; }
    } else if (call.path.endsWith('/url')) data = { assetId: call.path.split('/')[3], url: 'https://example.test/refreshed', contentType: 'image/png' };
    else if (call.method === 'DELETE') data = { deleted: true, supplierDeletion: { status: 'confirmed' } };
    else if (call.path.endsWith('/withdraw')) data = { consent: { action: 'withdrawn' }, deletionScheduled: false, supplierPending: [] };
    else { status = 404; code = 'NOT_FOUND'; }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code, data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const requests = new Set(); let closed = false;
  t.after(() => new Promise(resolve => {
    closed = true;
    // No global fetch/Undici pool can retain a socket for a later fixture that
    // happens to receive this ephemeral port. Also close unfinished local I/O.
    for (const request of requests) request.destroy(Object.assign(new Error('Fixture closed'), { code: 'FIXTURE_CLOSED' }));
    server.close(resolve); server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const localRequest = async options => {
    transportCalls.push(options);
    if (closed) throw Object.assign(new Error('Fixture closed'), { code: 'FIXTURE_CLOSED' });
    const pathname = options.path || new URL(options.url).pathname;
    return new Promise((resolve, reject) => {
      // Each request owns one connection. No retries: a deliberately dropped
      // response must still reach the client's original unknown-result branch.
      const request = httpRequest(`${origin}${pathname}`, { method: options.method || 'GET', headers: options.header, agent: false }, async response => {
        try {
          const chunks = []; for await (const chunk of response) chunks.push(chunk);
          resolve({ statusCode: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
      requests.add(request);
      request.once('close', () => requests.delete(request));
      request.once('error', reject);
      request.setTimeout(options.timeout || 15000, () => request.destroy(Object.assign(new Error('Fixture request timed out'), { code: 'ETIMEDOUT' })));
      request.end(options.data === undefined ? undefined : JSON.stringify(options.data));
    });
  };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    login: options => options.success({ code: 'fictional-code' }),
    getRandomValues: options => options.success({ randomValues: new Uint8Array(16).fill(++randomCalls).buffer }),
    request: options => { localRequest(options).then(options.success, error => options.fail({
      errMsg: `request:fail ${error?.cause?.code || error?.code || 'UNKNOWN'}`, cause: error,
      transportCode: error?.cause?.code || error?.code || 'UNKNOWN',
    })); },
    requestVirtualPayment: () => { nativePayments++; assert.fail('creation must never invoke a payment API'); },
    downloadFile: options => { saved.push({ download: options.url }); options.success({ statusCode: 200, tempFilePath: '/fictional/temp.png' }); },
    saveImageToPhotosAlbum: options => { saved.push({ album: options.filePath }); options.success({}); },
    getFileSystemManager: () => ({ unlink: options => removed.push(options.filePath) }),
  };
  if (cloud) {
    wx.cloud = { callContainer: options => localRequest(options) };
    wx.request = () => assert.fail('cloud must not fall back to public HTTP');
  }
  const endpoint = cloud ? { mode: 'cloud', env: 'fictional-env', service: 'fictional-service' } : 'https://example.test';
  return { client: createCreationClient(wx, endpoint, { enabled }), wx, facts, calls, transportCalls, works, jobs, jobsByKey, uploads, uploadsByKey, storage, stages, saved, removed,
    endpoint, nativePayments: () => nativePayments, generate: client => (client || {}).generate?.({ image, effectId: 'effect1', consent }, stage => stages.push(stage)) };
}

test('accurate per-effect availability fails closed without enabling flags or approved disclosure', () => {
  const f = publicFacts();
  assert.equal(photoAvailability(f.catalog, f.compliance, f.capabilities, true).available, true);
  assert.equal(photoAvailability(f.catalog, f.compliance, f.capabilities, false).available, false);
  assert.equal(photoAvailability(f.catalog, f.compliance, f.capabilities, true).effects[1].available, false);
  for (const change of [
    value => { delete value.catalog.miniProgramCreation; }, value => { value.catalog.miniProgramCreation.available = 'true'; },
    value => { delete value.catalog.miniProgramCreation.jobProtocol; }, value => { value.catalog.miniProgramCreation.jobProtocol = 'sync-v0'; },
    value => { value.catalog.settings.generationEnabled = false; }, value => { value.capabilities[0].ready = false; },
    value => { value.capabilities[0].status = 'blocked_pending_evidence'; },
    value => { value.compliance.status = 'pending_company_approval'; }, value => { delete value.compliance.retention; },
    value => { value.compliance.aiServices[0].capabilities = ['video-fusion']; },
    value => { value.catalog.miniProgramCreation.photoEffectIds = ['unpublished']; },
  ]) { const changed = publicFacts(); change(changed); assert.equal(photoAvailability(changed.catalog, changed.compliance, changed.capabilities, true).available, false); }
});

test('default-disabled creation still reads rights/works and never submits a costly request', async t => {
  const f = await fixture(t, { enabled: false });
  const snapshot = await f.client.refresh();
  assert.equal(snapshot.photo, 4); assert.equal(snapshot.available, false);
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_NOT_AVAILABLE');
  assert.equal(f.calls.some(call => call.path === '/api/mini/photo-uploads' || call.path === '/api/mini/photo-jobs'), false);
  assert.equal(f.storage.size, 0); assert.equal(f.nativePayments(), 0);
});

test('a catalog with only the old job protocol never opens the new upload flow or leaves a pending lock', async t => {
  for (const value of [undefined, 'photo-uploads-v0']) {
    const f = await fixture(t); f.facts.catalog.miniProgramCreation.uploadProtocol = value;
    assert.equal((await f.client.refresh()).available, false);
    await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_NOT_AVAILABLE');
    assert.equal(f.calls.some(call => call.path.startsWith('/api/mini/photo-uploads') || call.path === '/api/mini/photo-jobs'), false);
    assert.equal(f.storage.size, 0);
  }
});

test('202 submission records current separate consent and one fixed-key durable task without claiming a result', async t => {
  const f = await fixture(t);
  const result = await f.generate(f.client);
  assert.equal(result.pending, true); assert.deepEqual(result.job, { id: 'job1', state: 'queued', effectId: 'effect1', effectSource: 'account-pending' });
  assert.equal(result.assetId, undefined); assert.equal(result.url, undefined); assert.equal(result.inputAssetId, 'input1');
  assert.deepEqual(f.stages, ['authorizing', 'uploading', 'generating']);
  const grants = f.calls.filter(call => call.path === '/api/consents' && call.method === 'POST');
  assert.deepEqual(grants.map(call => call.data), [
    { consentType: 'basic', version: 'basic-v1', action: 'granted' },
    { consentType: 'face_processing', version: 'face-v1', action: 'granted', subjectAuthorization: 'self' },
  ]);
  const submitted = f.calls.find(call => call.path === '/api/mini/photo-jobs');
  assert.deepEqual(submitted.data, { inputAssetId: 'input1', effectId: 'effect1' });
  assert.match(submitted.headers['idempotency-key'], /^[a-f0-9]{32}$/);
  assert.ok(f.calls.indexOf(grants[1]) < f.calls.findIndex(call => call.path === '/api/mini/photo-uploads'));
  assert.equal(f.storage.size, 1); assert.equal(f.nativePayments(), 0);
  assert.equal(f.storage.get('lyx-creation-pending:buyer').jobId, 'job1');
  assert.equal(f.storage.get('lyx-creation-pending:buyer').protocol, 'photo-jobs-v1');
  assert.equal(f.calls.some(call => call.path.endsWith('/url') || call.path === '/api/photo/effect'), false);
  assert.equal(f.calls.some(call => call.path === '/api/readiness'), false);
});

test('missing separate consent, stale versions or unreviewed effects do not upload or generate', async t => {
  const f = await fixture(t);
  for (const body of [
    { image, effectId: 'effect1', consent: { ...consent, faceAgreed: false } },
    { image, effectId: 'effect1', consent: { ...consent, subjectAuthorization: '' } },
    { image, effectId: 'effect1', consent: { ...consent, faceVersion: 'old-version' } },
    { image, effectId: 'unreviewed', consent },
  ]) await assert.rejects(f.client.generate(body));
  assert.equal(f.calls.some(call => call.path === '/api/mini/photo-uploads' || call.path === '/api/mini/photo-jobs'), false);
});

test('accepted submission with a lost response recovers by key then id after restart without another POST', async t => {
  const f = await fixture(t, { override: (call, state) => {
    if (call.path === '/api/mini/photo-jobs') { state.acceptJob(call); return { drop: true }; }
  } });
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
  const pending = f.storage.get('lyx-creation-pending:buyer');
  assert.match(pending.idempotencyKey, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(pending).includes('data:image'), false);
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal(pending.jobId, undefined); assert.equal(f.jobs.size, 1);
  const recovered = await restarted.refresh();
  assert.equal(recovered.pending.jobId, 'job1'); assert.equal(recovered.job.state, 'queued');
  assert.equal(recovered.result, undefined);
  await assert.rejects(f.generate(restarted), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/mini/photo-jobs/by-key/')).length, 1);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs/job1').length, 1);
  assert.equal(f.storage.size, 1); assert.equal(f.nativePayments(), 0);
});

test('404, absent job and network-unknown lookup never unlock an unconfirmed accepted request', async t => {
  for (const response of [{ status: 404, code: 'PHOTO_JOB_NOT_FOUND' }, { data: {} }, { drop: true }]) {
    const f = await fixture(t, { override: (call, state) => {
      if (call.path === '/api/mini/photo-jobs') { state.acceptJob(call); return { drop: true }; }
      if (call.path.startsWith('/api/mini/photo-jobs/')) return response;
    } });
    await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
    const original = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
    const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
    const recovered = await restarted.refresh();
    assert.deepEqual(recovered.pending, original); assert.equal(recovered.job.state, 'unconfirmed');
    assert.equal(recovered.result, undefined);
    await assert.rejects(f.generate(restarted), error => error.code === 'CREATION_UNCONFIRMED');
    assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
    assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-uploads').length, 1);
    assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
  }
});

test('queued, running and uncertain jobs preserve the pending lock and never fetch a private result URL', async t => {
  const f = await fixture(t);
  await f.generate(f.client);
  for (const state of ['queued', 'claimed', 'result_ready', 'blocked', 'unknown']) {
    f.jobs.set('job1', { id: 'job1', state, assetId: 'unpublished-result' });
    const value = await f.client.refresh();
    assert.equal(value.pending.jobId, 'job1'); assert.equal(value.job.state, state);
    assert.equal(value.result, undefined); assert.equal(f.storage.size, 1);
  }
  assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
});

test('only a completed durable job fetches its own private URL, clears pending, and returns the original input', async t => {
  const f = await fixture(t);
  await f.generate(f.client);
  f.jobs.set('job1', { id: 'job1', state: 'succeeded', assetId: 'result1' });
  const result = await f.client.refresh();
  assert.equal(result.pending, null); assert.equal(result.job.state, 'succeeded');
  assert.deepEqual(result.result, { assetId: 'result1', inputAssetId: 'input1', url: 'https://example.test/refreshed',
    effectId: 'effect1', effectSource: 'account-pending' });
  assert.equal(f.storage.size, 0);
  assert.ok(f.calls.findIndex(call => call.path === '/api/mini/photo-jobs/job1')
    < f.calls.findIndex(call => call.path === '/api/assets/result1/url'));
  const before = f.calls.length;
  await f.client.refresh();
  assert.equal(f.calls.slice(before).some(call => call.path.startsWith('/api/mini/photo-jobs') || call.path.endsWith('/url')), false);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
});

test('malformed job identity, state and result reference cannot produce success or erase pending', async t => {
  for (const job of [
    { id: 'another-job', state: 'succeeded', assetId: 'result1' },
    { id: '../job1', state: 'succeeded', assetId: 'result1' },
    { id: 'job1', state: 'complete', assetId: 'result1' },
    { id: 'job1', state: 'succeeded' },
    { id: 'job1', state: 'succeeded', assetId: '../other-user' },
    { id: 'job1', state: 'succeeded', assetId: 'https://example.test/private' },
    { id: 'job1', state: 'succeeded', assetId: 'result1', effectId: 'different-effect' },
    { id: 'job1', state: 'succeeded', assetId: 'result1', effectId: '../effect' },
    { id: 'job1', state: 'succeeded', assetId: 'result1', effectId: null },
  ]) {
    const f = await fixture(t);
    await f.generate(f.client); f.jobs.set('job1', job);
    const value = await f.client.refresh();
    assert.equal(value.result, undefined); assert.equal(value.job.state, 'unconfirmed');
    assert.equal(value.pending.jobId, 'job1'); assert.equal(f.storage.size, 1);
    assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
  }
});

test('a matching server job effect remains bound to the original pending effect across restart and by-key recovery', async t => {
  const f = await fixture(t);
  await f.generate(f.client);
  const pending = f.storage.get('lyx-creation-pending:buyer'); delete pending.jobId;
  f.storage.set('lyx-creation-pending:buyer', pending);
  f.jobs.set('job1', { id: 'job1', state: 'succeeded', assetId: 'result1', effectId: 'effect1' });
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  const value = await restarted.refresh();
  assert.equal(value.result.effectId, 'effect1'); assert.equal(value.result.effectSource, 'server-job');
  assert.equal(value.result.assetId, 'result1'); assert.equal(value.pending, null);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST').length, 1);
  assert.ok(f.calls.some(call => call.path.startsWith('/api/mini/photo-jobs/by-key/')));
  assert.equal(f.nativePayments(), 0);
});

test('malformed 202 receipt stays locked and restarts with key lookup instead of new submission', async t => {
  const f = await fixture(t, { override: (call, state) => {
    if (call.path === '/api/mini/photo-jobs') { state.acceptJob(call); return { status: 202, data: { job: { id: 'job1', state: 'delivered' } } }; }
  } });
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal((await restarted.refresh()).pending.jobId, 'job1');
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
  assert.equal(f.calls.some(call => call.path.startsWith('/api/mini/photo-jobs/by-key/')), true);
});

test('a completed job whose asset URL is unavailable stays recoverable without regeneration', async t => {
  let urlFailure = true;
  const f = await fixture(t, { override: call => call.path === '/api/assets/result1/url' && urlFailure
    ? { status: 503, code: 'STORAGE_UNAVAILABLE' } : undefined });
  await f.generate(f.client);
  f.jobs.set('job1', { id: 'job1', state: 'succeeded', assetId: 'result1' });
  const first = await f.client.refresh();
  assert.equal(first.result, undefined); assert.equal(first.pending.jobId, 'job1');
  assert.equal(f.storage.size, 1);
  urlFailure = false;
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal((await restarted.refresh()).result.assetId, 'result1');
  assert.equal(f.storage.size, 0);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
});

test('invalid or mismatched private asset responses cannot release the completed-job lock', async t => {
  for (const asset of [
    { assetId: 'result1', url: 'http://example.test/insecure' },
    { assetId: 'result1', url: '' },
    { assetId: 'different-asset', url: 'https://example.test/wrong-result' },
  ]) {
    const f = await fixture(t, { override: call => call.path === '/api/assets/result1/url' ? { data: asset } : undefined });
    await f.generate(f.client);
    f.jobs.set('job1', { id: 'job1', state: 'succeeded', assetId: 'result1' });
    const value = await f.client.refresh();
    assert.equal(value.result, undefined, `must reject ${asset.url}`);
    assert.equal(value.pending.jobId, 'job1'); assert.equal(f.storage.size, 1);
  }
});

test('confirmed cancellation unlocks without claiming a result or automatically creating another job', async t => {
  const f = await fixture(t);
  await f.generate(f.client); f.jobs.set('job1', { id: 'job1', state: 'cancelled' });
  const value = await f.client.refresh();
  assert.equal(value.pending, null); assert.equal(value.job.state, 'cancelled'); assert.equal(value.result, undefined);
  assert.equal(f.storage.size, 0); assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
});

test('a legacy synchronous pending record remains locked instead of looking up or replaying it as a new job', async t => {
  const old = { effectId: 'effect1', inputAssetId: 'input1', idempotencyKey: 'a'.repeat(32) };
  const f = await fixture(t, { storage: new Map([['lyx-creation-pending:buyer', old]]) });
  const value = await f.client.refresh();
  assert.deepEqual(value.pending, old); assert.equal(value.job.state, 'unknown');
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(f.calls.some(call => call.path.startsWith('/api/mini/photo-jobs') || call.path === '/api/mini/photo-uploads'), false);
});

test('another account starting a fresh client neither reads nor clears the original account pending task', async t => {
  let account = 'buyer';
  const f = await fixture(t, { override: call => call.path === '/api/auth/wechat'
    ? { data: { token: `fictional-${account}`, user: { id: account } } } : undefined });
  await f.generate(f.client);
  const original = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
  const before = f.calls.length; account = 'other-buyer';
  const other = createCreationClient(f.wx, f.endpoint, { enabled: true });
  const value = await other.refresh();
  assert.equal(value.pending, null); assert.equal(value.result, undefined);
  assert.equal(f.calls.slice(before).some(call => call.path.startsWith('/api/mini/photo-jobs')), false);
  assert.deepEqual(f.storage.get('lyx-creation-pending:buyer'), original);
  assert.equal(f.storage.has('lyx-creation-pending:other-buyer'), false);
});

test('account switching during authenticated job recovery blocks replay and keeps the original pending record', async t => {
  let login = 0, recovering = false;
  const f = await fixture(t, { override: call => {
    if (call.path === '/api/auth/wechat') return { data: { token: `fictional-${++login}`, user: { id: login <= 2 ? 'buyer' : 'other-buyer' } } };
    if (recovering && call.path === '/api/mini/photo-jobs/job1') return { status: 401, code: 'AUTH_SESSION_EXPIRED' };
  } });
  await f.generate(f.client); recovering = true;
  const original = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
  await assert.rejects(f.client.refresh(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs/job1').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
  assert.deepEqual(f.storage.get('lyx-creation-pending:buyer'), original);
  assert.equal(f.storage.has('lyx-creation-pending:other-buyer'), false);
  assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
});

test('corrupt persisted task references fail closed before querying or generating', async t => {
  for (const corruption of [{ effectId: '../effect' }, { inputAssetId: 'https://example.test/input' }, { idempotencyKey: 'invalid' },
    { jobId: '../other-job' }, { state: 'delivered' }]) {
    const pending = { effectId: 'effect1', inputAssetId: 'input1', idempotencyKey: 'a'.repeat(32), protocol: 'photo-jobs-v1', ...corruption };
    const f = await fixture(t, { storage: new Map([['lyx-creation-pending:buyer', pending]]) });
    await assert.rejects(f.client.refresh(), error => error.code === 'CREATION_PENDING_INVALID');
    await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_PENDING_INVALID');
    assert.deepEqual(f.storage.get('lyx-creation-pending:buyer'), pending);
    assert.equal(f.calls.some(call => call.path.startsWith('/api/mini/photo-jobs') || call.path === '/api/mini/photo-uploads'), false);
  }
});

test('a definite pre-submission rejection unlocks, but generic 500 or duplicate outcomes remain pending', async t => {
  for (const [code, status, remainsPending] of [['INSUFFICIENT_ENTITLEMENT', 402, false],
    ['GENERATION_PAUSED', 503, false], ['XPAY_PROVIDER_BUDGET_LIMIT', 429, false],
    ['PHOTO_JOB_UNCONFIRMED', 503, true], ['DB_COMMIT_UNKNOWN', 503, true],
    [500, 500, true], ['DUPLICATE_GENERATION_REQUEST', 409, true]]) {
    const f = await fixture(t, { override: call => call.path === '/api/mini/photo-jobs' ? { code, status } : undefined });
    await assert.rejects(f.generate(f.client));
    assert.equal(f.storage.has('lyx-creation-pending:buyer'), remainsPending);
    assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
  }
});

test('definite 401 recovery preserves the same generation key, never invoking virtual payment', async t => {
  let attempts = 0;
  const f = await fixture(t, { cloud: true, override: call =>
    call.path === '/api/mini/photo-jobs' && ++attempts === 1 ? { status: 401, code: 'AUTH_SESSION_EXPIRED' } : undefined });
  await f.generate(f.client);
  const submissions = f.calls.filter(call => call.path === '/api/mini/photo-jobs');
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].headers['idempotency-key'], submissions[1].headers['idempotency-key']);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-uploads').length, 1);
  assert.ok(f.transportCalls.every(call => call.timeout <= 15000));
  assert.equal(f.storage.size, 1); assert.equal(f.jobs.size, 1); assert.equal(f.nativePayments(), 0);
});

test('account change during generation recovery stops replay and preserves only the original account pending record', async t => {
  let login = 0;
  const f = await fixture(t, { override: call => {
    if (call.path === '/api/auth/wechat') return { data: { token: `fake-${++login}`, user: { id: login === 1 ? 'buyer' : 'other-buyer' } } };
    if (call.path === '/api/mini/photo-jobs') return { status: 401, code: 'AUTH_SESSION_EXPIRED' };
  } });
  await assert.rejects(f.generate(f.client), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
  assert.equal(f.storage.has('lyx-creation-pending:buyer'), true);
  assert.equal(f.storage.has('lyx-creation-pending:other-buyer'), false);
  await assert.rejects(f.client.refresh(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
});

test('duplicate taps cannot concurrently upload or generate', async t => {
  const f = await fixture(t);
  const first = f.generate(f.client);
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_IN_PROGRESS');
  await first;
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-uploads').length, 1);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 1);
});

test('202 supplier deletion is exposed as partial for both asset deletion and face-consent withdrawal', async t => {
  const f = await fixture(t, { override: call => call.method === 'DELETE' || call.path.endsWith('/withdraw')
    ? { status: 202, code: 'ERASURE_PARTIAL', data: { deleted: true, consent: { action: 'withdrawn' }, supplierPending: [{ status: 'pending' }] } } : undefined });
  assert.equal((await f.client.deleteAsset('result1')).partial, true);
  assert.equal((await f.client.withdrawFaceConsent()).partial, true);
  assert.equal(f.calls.filter(call => call.path === '/api/mini/photo-jobs').length, 0);
});

test('saving refreshes ownership and the short-lived URL, then removes temporary downloaded media', async t => {
  const f = await fixture(t);
  await f.client.saveAsset('result1');
  assert.deepEqual(f.saved, [{ download: 'https://example.test/refreshed' }, { album: '/fictional/temp.png' }]);
  assert.deepEqual(f.removed, ['/fictional/temp.png']);
  assert.equal(f.calls.filter(call => call.path === '/api/auth/wechat').length, 2);
  assert.equal(f.calls.filter(call => call.path === '/api/assets/result1/url').length, 1);
});

test('saving an asset rejects a mismatched private asset response before downloading or copying to album', async t => {
  const f = await fixture(t, { override: call => call.path === '/api/assets/result1/url'
    ? { data: { assetId: 'someone-elses-result', url: 'https://example.test/wrong-private-result' } } : undefined });
  await assert.rejects(f.client.saveAsset('result1'), error => error.code === 'INVALID_ASSET');
  assert.deepEqual(f.saved, []); assert.deepEqual(f.removed, []);
});

test('fresh identity on refresh or destructive actions rejects a switched account before querying/deleting old data', async t => {
  let login = 0;
  const f = await fixture(t, { override: call => call.path === '/api/auth/wechat'
    ? { data: { token: `fake-${++login}`, user: { id: login === 1 ? 'buyer' : 'other-buyer' } } } : undefined });
  await f.client.refresh();
  const before = f.calls.length;
  await assert.rejects(f.client.deleteAsset('result1'), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  await assert.rejects(f.client.withdrawFaceConsent(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.calls.slice(before).some(call => call.method === 'DELETE' || call.path.endsWith('/withdraw')), false);
});

test('malformed success responses cannot claim confirmed deletion or withdrawal', async t => {
  const f = await fixture(t, { override: call => call.method === 'DELETE' || call.path.endsWith('/withdraw') ? { data: {} } : undefined });
  await assert.rejects(f.client.deleteAsset('result1'), error => error.code === 'DELETE_UNCONFIRMED');
  await assert.rejects(f.client.withdrawFaceConsent(), error => error.code === 'WITHDRAW_UNCONFIRMED');
});

test('failed album permission still removes temporary private download and never reports saving success', async t => {
  const f = await fixture(t);
  f.wx.saveImageToPhotosAlbum = options => options.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
  await assert.rejects(f.client.saveAsset('result1'));
  assert.deepEqual(f.removed, ['/fictional/temp.png']);
});

function nativePage(client, wx = {}) {
  let page, timerId = 0;
  const timers = new Map();
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/create/index.js', import.meta.url), 'utf8'), {
    require: name => { if (name === '../../photo-input') return { prepareLocalPhoto }; assert.equal(name, '../../creation'); return { createCreationClient: () => client, imageLimit: 2 * 1024 * 1024 }; },
    Page: definition => { page = definition; }, wx: {
      getPrivacySetting: options => options.success({ needAuthorization: false }), requirePrivacyAuthorize: options => options.success({}), ...wx },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    getApp: () => ({ globalData: { creationEnabled: false, apiTransport: { mode: 'cloud', env: 'test-env', service: '' } } }),
  });
  page.data = structuredClone(page.data); page.setData = values => Object.assign(page.data, values);
  // Unit cases that invoke a handler directly model an already admitted page;
  // onLoad always resets admission and exercises the real privacy gate.
  page.visible = true; page.readAccessReady = true;
  page.testClock = {
    timers,
    async fire() {
      const next = timers.entries().next().value;
      assert.ok(next, 'a scheduled polling timer must exist');
      const [id, timer] = next; assert.equal(timer.delay, 3000); timers.delete(id); timer.callback();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  return page;
}

const firstUpload = f => f.uploads.values().next().value;
const finishUpload = f => Object.assign(firstUpload(f), { state: 'ready', assetId: 'input1', updatedAt: 2 });
const uploadPostCount = f => f.calls.filter(call => call.path === '/api/mini/photo-uploads' && call.method === 'POST').length;
const jobPostCount = f => f.calls.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST').length;

test('upload intent and independent generation key persist before POST; queued bytes never count as reviewed or generated', async t => {
  let savedBeforePost;
  const f = await fixture(t, { cloud: true, uploadState: 'queued', override: call => {
    if (call.path === '/api/mini/photo-uploads') savedBeforePost = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
  } });
  const value = await f.generate(f.client);
  assert.equal(value.pending, true); assert.equal(value.job.state, 'upload_queued');
  assert.equal(value.inputAssetId, undefined); assert.equal(value.result, undefined); assert.equal(jobPostCount(f), 0);
  const request = f.calls.find(call => call.path === '/api/mini/photo-uploads');
  assert.equal(savedBeforePost.protocol, 'photo-uploads-v1');
  assert.equal(savedBeforePost.uploadKey, request.headers['idempotency-key']);
  assert.match(savedBeforePost.generationKey, /^[a-f0-9]{32}$/);
  assert.notEqual(savedBeforePost.uploadKey, savedBeforePost.generationKey);
  assert.doesNotMatch(JSON.stringify(savedBeforePost), /data:image|base64/);
  assert.equal(f.transportCalls.find(call => call.path === '/api/mini/photo-uploads').timeout, 15000);
  finishUpload(f);
  const ready = await f.client.refresh();
  assert.equal(ready.job.state, 'queued'); assert.equal(jobPostCount(f), 1);
  assert.equal(f.calls.find(call => call.path === '/api/mini/photo-jobs').headers['idempotency-key'], savedBeforePost.generationKey);
  assert.equal(uploadPostCount(f), 1); assert.equal(f.nativePayments(), 0);
});

test('accepted upload with a lost response restarts using only its key then ID and never reuploads', async t => {
  const f = await fixture(t, { uploadState: 'queued', override: (call, state) => {
    if (call.path === '/api/mini/photo-uploads') { state.acceptUpload(call); return { drop: true }; }
  } });
  await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(f.storage.get('lyx-creation-pending:buyer').uploadId, undefined);
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal((await restarted.refresh()).job.state, 'upload_queued');
  assert.equal((await restarted.refresh()).job.state, 'upload_queued');
  await assert.rejects(f.generate(restarted), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(f.calls.filter(call => call.path.startsWith('/api/mini/photo-uploads/by-key/')).length, 1);
  assert.equal(uploadPostCount(f), 1); assert.equal(jobPostCount(f), 0);
  finishUpload(f); await restarted.refresh();
  assert.equal(uploadPostCount(f), 1); assert.equal(jobPostCount(f), 1);
});

test('missing, 404 or transport-unknown upload lookups keep the original lock and never authorize a second upload', async t => {
  for (const response of [{ data: { upload: null } }, { status: 404, code: 'PHOTO_UPLOAD_NOT_FOUND' }, { drop: true }]) {
    const f = await fixture(t, { override: call => call.path === '/api/mini/photo-uploads' ? { drop: true }
      : call.path.startsWith('/api/mini/photo-uploads/') ? response : undefined });
    await assert.rejects(f.generate(f.client), error => error.code === 'CREATION_UNCONFIRMED');
    const original = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
    const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
    assert.equal((await restarted.refresh()).job.state, 'unconfirmed');
    await assert.rejects(f.generate(restarted), error => error.code === 'CREATION_UNCONFIRMED');
    assert.deepEqual(f.storage.get('lyx-creation-pending:buyer'), original);
    assert.equal(uploadPostCount(f), 1); assert.equal(jobPostCount(f), 0);
  }
});

test('wrong upload identity, premature asset and malformed review receipt cannot advance or erase the upload lock', async t => {
  for (const corrupt of [{ id: 'wrong' }, { id: `upload_${'f'.repeat(32)}` }, { state: 'succeeded', assetId: 'input1' },
    { state: 'ready' }, { state: 'ready', assetId: 'https://example.test/private' }, { state: 'queued', assetId: 'input1' },
    { createdAt: -1 }, { updatedAt: 0 }]) {
    const f = await fixture(t, { uploadState: 'queued' });
    await f.generate(f.client); Object.assign(firstUpload(f), corrupt);
    assert.equal((await f.client.refresh()).job.state, 'unconfirmed');
    assert.equal(f.storage.size, 1); assert.equal(jobPostCount(f), 0);
    assert.equal(f.calls.some(call => call.path.endsWith('/url')), false);
  }
});

test('upload review and unknown remain held; confirmed rejected or cancelled uploads end without generating or refunding', async t => {
  for (const state of ['staging', 'claimed', 'reviewed', 'review', 'unknown', 'rejected', 'cancelled']) {
    const f = await fixture(t, { uploadState: 'queued' }); await f.generate(f.client);
    firstUpload(f).state = state;
    const value = await f.client.refresh();
    assert.equal(value.job.state, `upload_${state}`);
    assert.equal(Boolean(value.pending), !['rejected', 'cancelled'].includes(state));
    assert.equal(jobPostCount(f), 0); assert.equal(f.nativePayments(), 0);
  }
});

test('concurrent ready-upload recovery submits one generation key; its lost reply then permits only job GET recovery', async t => {
  const f = await fixture(t, { uploadState: 'queued', override: (call, state) => {
    if (call.path === '/api/mini/photo-jobs') { state.acceptJob(call); return { drop: true }; }
  } });
  await f.generate(f.client); finishUpload(f);
  await Promise.all([f.client.refresh(), f.client.refresh(), f.client.refresh()]);
  assert.equal(uploadPostCount(f), 1); assert.equal(jobPostCount(f), 1);
  assert.equal(f.storage.get('lyx-creation-pending:buyer').protocol, 'photo-jobs-v1');
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal((await restarted.refresh()).job.state, 'queued');
  assert.equal(jobPostCount(f), 1);
});

test('a ready review response arriving after hiding cannot submit generation; showing resumes the original independent key', async t => {
  let release, observed;
  const entered = new Promise(resolve => { observed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { uploadState: 'queued', override: async call => {
    if (call.path.startsWith('/api/mini/photo-uploads/')) { observed(); await gate; }
  } });
  await f.generate(f.client); finishUpload(f);
  const generationKey = f.storage.get('lyx-creation-pending:buyer').generationKey;
  const waiting = f.client.refresh(); await entered;
  f.client.setActive(false); release();
  assert.equal((await waiting).job.state, 'upload_ready'); assert.equal(jobPostCount(f), 0);
  f.client.setActive(true);
  assert.equal((await f.client.refresh()).job.state, 'queued'); assert.equal(jobPostCount(f), 1);
  assert.equal(f.calls.find(call => call.path === '/api/mini/photo-jobs').headers['idempotency-key'], generationKey);
});

test('an initial ready-upload reply arriving after hiding is retained without generation', async t => {
  let release, observed;
  const entered = new Promise(resolve => { observed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { override: async call => { if (call.path === '/api/mini/photo-uploads') { observed(); await gate; } } });
  const waiting = f.generate(f.client); await entered; f.client.setActive(false); release();
  assert.equal((await waiting).job.state, 'upload_ready'); assert.equal(jobPostCount(f), 0);
  assert.equal(f.storage.get('lyx-creation-pending:buyer').state, 'ready');
});

test('late initial upload reply cannot rewind a generation already started by concurrent recovery', async t => {
  let release, observed;
  const entered = new Promise(resolve => { observed = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { override: async (call, state) => {
    if (call.path === '/api/mini/photo-uploads') { state.acceptUpload(call); observed(); await gate; }
  } });
  const waiting = f.generate(f.client); await entered;
  assert.equal((await f.client.refresh()).job.state, 'queued'); release(); await waiting;
  assert.equal(jobPostCount(f), 1); assert.equal(uploadPostCount(f), 1);
  assert.equal(f.storage.get('lyx-creation-pending:buyer').protocol, 'photo-jobs-v1');
});

test('upload recovery never reads or continues another account pending intent, including 401 account switches', async t => {
  let switchAccount = false, unauthorized = false;
  const f = await fixture(t, { uploadState: 'queued', override: call => {
    if (call.path === '/api/auth/wechat' && switchAccount) return { data: { token: 'other', user: { id: 'other-buyer' } } };
    if (call.path.startsWith('/api/mini/photo-uploads/') && unauthorized) { switchAccount = true; return { status: 401, code: 'SESSION_EXPIRED' }; }
  } });
  await f.generate(f.client); finishUpload(f);
  const original = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
  unauthorized = true;
  await assert.rejects(f.client.refresh(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  const before = f.calls.length;
  const restarted = createCreationClient(f.wx, f.endpoint, { enabled: true });
  assert.equal((await restarted.refresh()).pending, null);
  assert.equal(f.calls.slice(before).some(call => call.path.startsWith('/api/mini/photo-uploads')), false);
  assert.deepEqual(f.storage.get('lyx-creation-pending:buyer'), original);
  assert.equal(jobPostCount(f), 0); assert.equal(f.storage.has('lyx-creation-pending:other-buyer'), false);
});

test('only definite upload-admission rejection clears its key; conflict, commit uncertainty and generic errors keep it', async t => {
  for (const [code, status, locked] of [['PHOTO_UPLOAD_BUDGET_LIMIT', 429, false], ['PHOTO_UPLOAD_INVALID_REQUEST', 413, false],
    ['PHOTO_UPLOAD_NOT_AUTHORIZED', 403, false], ['PHOTO_UPLOAD_NOT_AVAILABLE', 503, false], ['PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE', 503, true],
    ['PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT', 409, true], ['PHOTO_UPLOAD_UNCONFIRMED', 503, true], ['DB_COMMIT_UNKNOWN', 503, true]]) {
    const f = await fixture(t, { override: call => call.path === '/api/mini/photo-uploads' ? { code, status } : undefined });
    await assert.rejects(f.generate(f.client));
    assert.equal(f.storage.size, locked ? 1 : 0); assert.equal(jobPostCount(f), 0); assert.equal(uploadPostCount(f), 1);
  }
});

test('preprocess failure after another same-key acceptance retains the key and GET recovers its queued upload', async t => {
  const f = await fixture(t, { uploadState: 'queued', override: (call, state) => {
    if (call.path !== '/api/mini/photo-uploads') return undefined;
    state.acceptUpload(call); // Another request has committed after our preflight.
    return { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE', status: 503 };
  } });
  await assert.rejects(f.generate(f.client), { code: 'CREATION_UNCONFIRMED' });
  const pending = structuredClone(f.storage.get('lyx-creation-pending:buyer'));
  assert.ok(pending?.uploadKey); assert.equal(f.uploads.size, 1);
  const resumed = await f.client.refresh();
  assert.equal(resumed.job.state, 'upload_queued'); assert.equal(resumed.pending.uploadKey, pending.uploadKey);
  assert.equal(uploadPostCount(f), 1); assert.equal(jobPostCount(f), 0);
});

test('disabled creation can inspect an already reviewed upload but cannot start its generation', async t => {
  const f = await fixture(t, { uploadState: 'queued' }); await f.generate(f.client); finishUpload(f);
  const disabled = createCreationClient(f.wx, f.endpoint, { enabled: false });
  const value = await disabled.refresh();
  assert.equal(value.job.state, 'upload_ready'); assert.ok(value.pending); assert.equal(jobPostCount(f), 0);
});

test('storage refusal before either initial POST cannot spend its upload or generation request', async t => {
  for (const protocol of ['photo-uploads-v1', 'photo-jobs-v1']) {
    const f = await fixture(t); const save = f.wx.setStorageSync;
    f.wx.setStorageSync = (key, value) => { if (value.protocol === protocol) throw new Error('local persistence refused'); save(key, value); };
    await assert.rejects(f.generate(f.client));
    assert.equal(uploadPostCount(f), protocol === 'photo-uploads-v1' ? 0 : 1); assert.equal(jobPostCount(f), 0);
  }
});

test('native lifecycle forwards foreground state and upload polling stays bounded without generating from the page', async () => {
  const active = []; let reads = 0;
  const page = nativePage({ setActive: value => active.push(value), entitlements: async () => ({ available: { photo: 3 } }),
    refresh: async () => { reads++; return pageSnapshot('upload_queued'); } });
  await page.onLoad();
  page.onHide(); await page.onShow(); page.onUnload();
  assert.deepEqual(active, [false, true, false, true, false]); assert.equal(page.testClock.timers.size, 0);
  assert.ok(reads >= 2);
});

function pageSnapshot(state = 'queued') {
  const facts = publicFacts();
  return { ...photoAvailability(facts.catalog, facts.compliance, facts.capabilities, true),
    compliance: facts.compliance, photo: 3, works: [], pending: { jobId: 'job1' }, job: { id: 'job1', state } };
}

test('native page bounds polling to 20 GET refresh cycles without repeating generation', async () => {
  let queries = 0, submissions = 0;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }),
    refresh: async () => { queries++; return pageSnapshot(); },
    generate: async () => { submissions++; assert.fail('polling cannot submit a job'); } });
  await page.onLoad();
  assert.equal(page.data.pending, true); assert.equal(page.data.result, null);
  for (let i = 0; i < 20; i++) { assert.equal(page.testClock.timers.size, 1); await page.testClock.fire(); }
  assert.equal(queries, 21); assert.equal(page.testClock.timers.size, 0); assert.equal(page.pollsLeft, 0);
  assert.equal(page.data.pending, true); assert.equal(submissions, 0);
  await page.generate(); assert.equal(submissions, 0);
});

test('backgrounding cancels polling and ignores a stale timer; returning resumes the same task', async () => {
  let queries = 0;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }),
    refresh: async () => { queries++; return pageSnapshot('claimed'); },
    generate: async () => assert.fail('background recovery must not generate') });
  await page.onLoad();
  const stale = [...page.testClock.timers.values()][0].callback;
  page.onHide(); assert.equal(page.testClock.timers.size, 0);
  stale(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 1); assert.equal(page.data.pending, true);
  await page.onShow(); assert.equal(queries, 2); assert.equal(page.testClock.timers.size, 1);
  page.onUnload(); assert.equal(page.testClock.timers.size, 0); assert.equal(page.photoData, null);
  stale(); await new Promise(resolve => setImmediate(resolve)); assert.equal(queries, 2);
});

test('hiding during an in-flight query ignores its late state and allows a fresh query on return', async () => {
  let resolveQuery;
  const query = new Promise(resolve => { resolveQuery = resolve; });
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: () => query });
  const loading = page.onLoad();
  await new Promise(resolve => setImmediate(resolve)); page.onHide();
  resolveQuery(pageSnapshot('result_ready')); await loading;
  assert.equal(page.data.pending, false); assert.equal(page.data.result, null); assert.equal(page.testClock.timers.size, 0);
  assert.equal(page.data.refreshing, false);
  await page.onShow(); assert.equal(page.data.pending, true);
});

test('unloading during a query cannot paint a late private result or restart polling', async () => {
  let resolveQuery;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }),
    refresh: () => new Promise(resolve => { resolveQuery = resolve; }) });
  const loading = page.onLoad(); await new Promise(resolve => setImmediate(resolve));
  page.photoData = image; page.onUnload();
  resolveQuery({ ...pageSnapshot('succeeded'), pending: null, result: { assetId: 'result1', url: 'https://example.test/private' } });
  await loading;
  assert.equal(page.data.result, null); assert.equal(page.photoData, null); assert.equal(page.testClock.timers.size, 0);
});

test('unknown or blocked provider outcome stops automatic polling while leaving the page locked', async () => {
  for (const state of ['unknown', 'blocked']) {
    const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: async () => pageSnapshot(state),
      generate: async () => assert.fail('uncertain task cannot be resubmitted') });
    await page.onLoad();
    assert.equal(page.data.pending, true); assert.equal(page.testClock.timers.size, 0);
    assert.equal(page.data.result, null); await page.generate();
  }
});

test('native page acknowledges 202 then polls the accepted task without displaying premature completion', async () => {
  let submissions = 0, queries = 0;
  const client = { entitlements: async () => ({ available: { photo: 3 } }),
    generate: async () => { submissions++; return { pending: true, job: { id: 'job1', state: 'queued' }, inputAssetId: 'input1' }; },
    refresh: async () => { queries++; return pageSnapshot(); } };
  const page = nativePage(client); page.client = client; page.visible = true; page.photoData = image;
  Object.assign(page.data, { available: true, effectAvailable: true, basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', effectId: 'effect1' });
  const first = page.generate(); await page.generate(); await first;
  assert.equal(submissions, 1); assert.equal(queries, 1); assert.equal(page.data.pending, true);
  assert.equal(page.data.result, null); assert.doesNotMatch(page.data.status, /制作完成/);
  assert.equal(page.testClock.timers.size, 1);
  await page.testClock.fire(); assert.equal(submissions, 1); assert.equal(queries, 2);
});

test('native page displays completion only after recovery returns the verified private result', async () => {
  let queries = 0;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: async () => {
    queries++;
    return queries === 1 ? pageSnapshot('result_ready') : { ...pageSnapshot('succeeded'), pending: null,
      works: [{ assetId: 'result1', kind: 'image', createdAt: '2026-10-09T00:00:00Z' }],
      result: { assetId: 'result1', inputAssetId: 'input1', url: 'https://example.test/private' } };
  } });
  await page.onLoad(); assert.equal(page.data.result, null); assert.equal(page.data.pending, true);
  await page.testClock.fire();
  assert.equal(page.data.pending, false); assert.equal(page.data.result.assetId, 'result1');
  assert.match(page.data.status, /制作完成/); assert.equal(page.testClock.timers.size, 0);
});

function completedPageSnapshot() {
  return { ...pageSnapshot('succeeded'), pending: null,
    works: [{ assetId: 'result1', kind: 'image', createdAt: '2026-10-09T00:00:00Z' },
      { assetId: 'other-result', kind: 'image', createdAt: '2026-10-08T00:00:00Z' }],
    result: { assetId: 'result1', inputAssetId: 'input1', url: 'https://example.test/private' } };
}

async function pageWithDelayedRefresh() {
  let delayed = false, settle, queryStarted;
  const started = new Promise(resolve => { queryStarted = resolve; });
  const response = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const client = { entitlements: async () => ({ available: { photo: 3 } }),
    refresh: async () => { if (!delayed) return completedPageSnapshot(); queryStarted(); return response; },
    deleteAsset: async () => ({ partial: false }), withdrawFaceConsent: async () => ({ partial: false }) };
  const page = nativePage(client, { showModal: options => options.success({ confirm: true }) });
  await page.onLoad();
  page.photoData = image;
  Object.assign(page.data, { selectedPhoto: '/fictional/private-input.png', faceAgreed: true, subjectAuthorization: 'self' });
  delayed = true;
  return { page, client, started, settle };
}

test('late refresh cannot restore private results after face consent withdrawal has completed', async () => {
  const { page, started, settle } = await pageWithDelayedRefresh();
  const refreshing = page.refresh(); await started;
  await page.withdrawConsent();
  assert.equal(page.data.result, null); assert.equal(page.data.works.length, 0);
  assert.equal(page.photoData, null); assert.equal(page.data.faceAgreed, false);
  const erasureNotice = page.data.erasureNotice;
  settle.resolve(completedPageSnapshot()); await refreshing;
  assert.equal(page.data.result, null, 'a pre-withdrawal result cannot reappear');
  assert.equal(page.data.works.length, 0, 'a pre-withdrawal works list cannot reappear');
  assert.equal(page.data.selectedPhoto, ''); assert.equal(page.photoData, null);
  assert.equal(page.data.faceAgreed, false); assert.equal(page.data.subjectAuthorization, '');
  assert.equal(page.data.erasureNotice, erasureNotice);
});

test('late refresh cannot restore a deleted result or its old works entry', async () => {
  const { page, started, settle } = await pageWithDelayedRefresh();
  const refreshing = page.refresh(); await started;
  await page.deleteWork({ currentTarget: { dataset: { id: 'result1' } } });
  assert.equal(page.data.result, null);
  assert.deepEqual(Array.from(page.data.works, work => work.assetId), ['other-result']);
  const erasureNotice = page.data.erasureNotice;
  settle.resolve(completedPageSnapshot()); await refreshing;
  assert.equal(page.data.result, null, 'a deleted result cannot reappear');
  assert.deepEqual(Array.from(page.data.works, work => work.assetId), ['other-result']);
  assert.equal(page.data.erasureNotice, erasureNotice);
});

test('a confirmed new works list clears an old result that is no longer available', async () => {
  let snapshot = completedPageSnapshot();
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: async () => snapshot });
  await page.onLoad(); assert.equal(page.data.result.assetId, 'result1');
  snapshot = { ...completedPageSnapshot(), result: undefined, works: [completedPageSnapshot().works[1]] };
  await page.refresh();
  assert.equal(page.data.result, null, 'server-confirmed absence must clear the previously displayed result');
  assert.deepEqual(Array.from(page.data.works, work => work.assetId), ['other-result']);
  assert.doesNotMatch(page.data.erasureNotice, /已删除/, 'absence alone does not prove a deletion operation');
});

test('a failed works refresh does not misclassify a previously available result as deleted', async () => {
  let failing = false;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: async () => {
    if (failing) throw new Error('temporary network outage'); return completedPageSnapshot();
  } });
  await page.onLoad(); failing = true;
  await page.refresh();
  assert.equal(page.data.result.assetId, 'result1');
  assert.deepEqual(Array.from(page.data.works, work => work.assetId), ['result1', 'other-result']);
  assert.doesNotMatch(page.data.erasureNotice, /已删除/);
});

test('a successful refresh that still lists the previous result keeps it available', async () => {
  let includeResult = true;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: async () => {
    const value = completedPageSnapshot(); if (!includeResult) delete value.result; return value;
  } });
  await page.onLoad(); includeResult = false; await page.refresh();
  assert.equal(page.data.result.assetId, 'result1');
  assert.equal(page.data.works.some(work => work.assetId === 'result1'), true);
});

test('native page keeps payment-only rights visible when creation API is missing', async () => {
  const page = nativePage({ entitlements: async () => ({ available: { photo: 10 } }), refresh: async () => { throw new Error('404'); } });
  await page.onLoad();
  assert.equal(page.data.photo, 10); assert.equal(page.data.available, false);
  assert.match(page.data.notice, /套餐与订单/);
});

test('native page clears private photos and works on account change and never shows stale success', async () => {
  const changed = new Error('account changed'); changed.code = 'XPAY_ACCOUNT_CHANGED';
  const page = nativePage({ entitlements: async () => { throw changed; }, refresh: async () => assert.fail('old account refresh'),
    generate: async () => ({ assetId: 'old-result', url: 'https://example.test/old-result' }) });
  page.client = { entitlements: async () => { throw changed; }, generate: async () => ({ assetId: 'old-result', url: 'https://example.test/old-result' }) };
  page.photoData = image;
  Object.assign(page.data, { available: true, effectAvailable: true, selectedPhoto: '/private/photo', works: [{ assetId: 'old-result' }],
    photo: 10, basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', effectId: 'effect1' });
  await page.generate();
  assert.equal(page.data.photo, null); assert.equal(page.data.selectedPhoto, '');
  assert.equal(page.data.result, null); assert.equal(page.data.works.length, 0); assert.equal(page.photoData, null);
  assert.match(page.data.notice, /账号已变化/);
});

test('native page announces partial deletion without claiming all processor copies were erased', async () => {
  const page = nativePage({}, { showModal: options => options.success({ confirm: true }) });
  page.client = { deleteAsset: async () => ({ partial: true }) };
  page.data.works = [{ assetId: 'result1' }]; page.data.result = { assetId: 'result1' };
  await page.deleteWork({ currentTarget: { dataset: { id: 'result1' } } });
  assert.equal(page.data.works.length, 0); assert.equal(page.data.result, null);
  assert.match(page.data.erasureNotice, /访问已撤销/);
  assert.match(page.data.erasureNotice, /云端和处理方副本删除仍待确认/);
  assert.doesNotMatch(page.data.erasureNotice, /已删除|正在删除|删除中/);
  page.client = { withdrawFaceConsent: async () => ({ partial: true }) };
  await page.withdrawConsent();
  assert.match(page.data.erasureNotice, /授权已撤回/);
  assert.match(page.data.erasureNotice, /云端和处理方副本删除仍待确认/);
  assert.doesNotMatch(page.data.erasureNotice, /已删除|正在删除|删除中/);
});

test('native photo selection waits for explicit privacy agreement and previews locally without invoking a server', async () => {
  let selections = 0, privacyCalls = 0;
  const wx = {
    getPrivacySetting: options => options.success({ needAuthorization: true, privacyContractName: '测试隐私指引' }),
    requirePrivacyAuthorize: options => { privacyCalls++; options.success({}); },
    chooseMedia: options => { selections++; options.success({ tempFiles: [{ tempFilePath: '/fictional/photo.png', size: 68 }] }); },
    getImageInfo: options => options.success({ type: 'png', width: 400, height: 500 }),
    getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: Buffer.from(image.split(',')[1], 'base64').length }), readFile: options => options.success({ data: image.split(',')[1] }) }),
    showToast: () => {},
  };
  const page = nativePage({}, wx);
  const cancelled = page.selectPhoto();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.data.privacyVisible, true); assert.equal(selections, 0);
  page.declineNativePrivacy(); await cancelled;
  assert.equal(selections, 0); assert.equal(page.photoData, undefined);
  const selected = page.selectPhoto();
  await new Promise(resolve => setImmediate(resolve));
  await page.agreeNativePrivacy(); await selected;
  assert.equal(privacyCalls, 1); assert.equal(selections, 1);
  assert.equal(page.data.selectedPhoto, '/fictional/photo.png'); assert.equal(page.photoData, image);
  assert.equal(page.data.faceAgreed, false); assert.equal(page.data.subjectAuthorization, '');
  page.clearPhoto(); assert.equal(page.photoData, null); assert.equal(page.data.selectedPhoto, '');
});

test('works and privacy routes read an already reviewed upload without creating a job on load or show', async t => {
  for (const view of ['works', 'privacy']) {
    const f = await fixture(t, { cloud: true, uploadState: 'queued' });
    await f.generate(f.client); finishUpload(f);
    const page = nativePage(f.client, { pageScrollTo() {} });
    await page.onLoad({ view });
    assert.equal(page.readOnly, true);
    assert.equal(page.data.pending, true);
    assert.equal(jobPostCount(f), 0);
    page.photoData = image;
    Object.assign(page.data, { pending: false, available: true, effectAvailable: true,
      basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', effectId: 'effect1' });
    await page.generate(); assert.equal(jobPostCount(f), 0);
    page.onHide(); await page.onShow();
    assert.equal(jobPostCount(f), 0);
    assert.equal(page.data.job?.state, undefined);
  }
});

test('onShow cannot bypass initial privacy admission; decline leaves zero account reads and permits explicit retry', async () => {
  let reads = 0, needsPrivacy = true;
  const page = nativePage({ setActive() {}, entitlements: async () => { reads++; return { available: { photo: 3 } }; },
    refresh: async () => { reads++; return pageSnapshot(); } }, {
    getPrivacySetting: options => options.success({ needAuthorization: needsPrivacy }),
    requirePrivacyAuthorize: options => options.success({}),
  });
  const loading = page.onLoad();
  await new Promise(resolve => setImmediate(resolve));
  await page.onShow(); assert.equal(reads, 0); assert.equal(page.readAccessReady, false);
  page.declineNativePrivacy(); await loading;
  assert.equal(reads, 0); assert.equal(page.data.connecting, false); assert.equal(page.data.readAccessReady, false);
  needsPrivacy = false; await page.connectReadAccess();
  assert.equal(reads, 2); assert.equal(page.data.readAccessReady, true);
});

test('hiding invalidates pending privacy agreement and late agreement cannot admit account reads', async () => {
  let grant, reads = 0;
  const page = nativePage({ entitlements: async () => { reads++; return { available: { photo: 3 } }; }, refresh: async () => pageSnapshot() }, {
    getPrivacySetting: options => options.success({ needAuthorization: true }),
    requirePrivacyAuthorize: options => { grant = options.success; },
  });
  const loading = page.onLoad(); await new Promise(resolve => setImmediate(resolve));
  const agreeing = page.agreeNativePrivacy();
  page.onHide(); await page.onShow();
  grant({}); await agreeing; await loading;
  assert.equal(reads, 0); assert.equal(page.readAccessReady, false);
  assert.equal(page.privacyTask, null); assert.equal(page.data.privacyVisible, false);
  assert.equal(page.data.connecting, false);
});

test('hidden photo selection discards late privacy, picker, image-info and file-read replies', async () => {
  for (const phase of ['privacy', 'picker', 'info', 'file']) {
    let release, reached;
    const started = new Promise(resolve => { reached = resolve; });
    const respond = (step, options, value) => {
      if (phase === step) { release = () => options.success(value); reached(); }
      else options.success(value);
    };
    const page = nativePage({}, {
      getPrivacySetting: options => respond('privacy', options, { needAuthorization: false }),
      requirePrivacyAuthorize: options => options.success({}),
      chooseMedia: options => respond('picker', options, { tempFiles: [{ tempFilePath: '/private/input.png', size: 10 }] }),
      getImageInfo: options => respond('info', options, { type: 'png', width: 400, height: 500 }),
      getFileSystemManager: () => ({ getFileInfo: options => options.success({ size: 5 }), readFile: options => respond('file', options, { data: 'aGVsbG8=' }) }),
      showToast: () => assert.fail('hidden page cannot emit stale photo error'),
    });
    const selecting = page.selectPhoto(); await started;
    page.onHide(); await page.onShow(); release(); await selecting;
    assert.equal(page.photoData, null, phase);
    assert.equal(page.data.selectedPhoto, '', phase);
    assert.equal(page.data.selecting, false, phase);
  }
});

test('old hidden refresh cannot paint private data over a newer foreground refresh or release its lock', async () => {
  let queries = 0, oldReply, newReply;
  const page = nativePage({ entitlements: async () => ({ available: { photo: 3 } }), refresh: () => {
    queries++; return new Promise(resolve => { if (queries === 1) oldReply = resolve; else newReply = resolve; });
  } });
  const loading = page.onLoad(); await new Promise(resolve => setImmediate(resolve));
  page.onHide(); const shown = page.onShow(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(queries, 2); assert.equal(page.data.refreshing, true);
  oldReply(completedPageSnapshot()); await loading;
  assert.equal(page.data.works.length, 0); assert.equal(page.data.photo, 3);
  assert.equal(page.data.result, null); assert.equal(page.data.refreshing, true);
  newReply({ ...pageSnapshot(), pending: null, photo: 7, works: [] }); await shown;
  assert.equal(page.data.photo, 7); assert.equal(page.data.refreshing, false);
});
