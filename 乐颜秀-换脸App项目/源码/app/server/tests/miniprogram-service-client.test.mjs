import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { createServiceClient, serviceInformation, publicHttps, categories } = createRequire(import.meta.url)('../../miniprogram/service.js');
const endpoint = { mode: 'cloud', env: 'fictional-env', service: 'fictional-service' };
const facts = () => ({ status: 'approved', operatorName: 'Synthetic Operator', supportContact: 'support@example.test',
  userAgreementUrl: 'https://example.test/terms', privacyPolicyUrl: 'https://example.test/privacy', thirdPartyListUrl: 'https://example.test/third-party',
  aiServices: [{ provider: 'Synthetic Provider', model: 'fictional-model', filingReference: 'fixture-only', purpose: '图片处理', region: 'fixture-region' }],
  retention: { sourceHours: 24, resultHours: 48, supplierPolicy: 'Synthetic retention statement' } });
const report = { category: 'other', description: '这是一条仅用于本地测试的问题说明' };
const received = { ticketId: 'rpt_01234567-1234-1234-1234-0123456789ab', status: 'submitted', createdAt: '2026-10-09T00:00:00.000Z' };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture({ user = 'buyer', override, storage = new Map() } = {}) {
  const calls = [], copied = []; let privacyCalls = 0, identity = user;
  const wx = {
    login: options => options.success({ code: 'synthetic-code' }),
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    clearStorageSync: () => assert.fail('must not clear another account or pending order'),
    setClipboardData: options => { copied.push(options.data); options.success({}); },
    openPrivacyContract: options => { privacyCalls++; options.success({}); },
    cloud: { async callContainer(call) {
      calls.push(call);
      const custom = await override?.(call);
      if (custom) return custom;
      let data;
      if (call.path === '/api/auth/wechat') data = { token: 'synthetic-token', user: { id: identity } };
      else if (call.path === '/api/public/compliance') data = facts();
      else if (call.path === '/api/reports' && call.method === 'POST') return { statusCode: 202, data: { code: 0, data: received } };
      else assert.fail(`Unexpected API: ${call.method} ${call.path}`);
      return { statusCode: 200, data: { code: 0, data } };
    } },
    request: () => assert.fail('must not open a fallback external transport'),
  };
  return { wx, storage, calls, copied, client: createServiceClient(wx, endpoint), privacyCalls: () => privacyCalls,
    switchAccount: value => { identity = value; } };
}
function pageFixture(client, wx = {}) {
  let page;
  const source = readFileSync(new URL('../../miniprogram/pages/service/index.js', import.meta.url), 'utf8');
  runInNewContext(source, { Page: value => { page = value; }, require: () => ({ createServiceClient: () => client, categories, serviceInformation }),
    wx, getApp: () => ({ globalData: { apiTransport: endpoint } }) });
  page.data = structuredClone(page.data); page.setData = value => Object.assign(page.data, value);
  page.client = client; page.closed = false; page.visible = true; page.revision = 0;
  return page;
}

test('service exposes refund operations only for the exact authenticated server boolean and safely hides failed discovery', async () => {
  for(const value of [true,false,'true',1,null]){
    const f=fixture({override:call=>call.path==='/api/mini/operations/status'?{statusCode:200,data:{code:0,data:{operator:value}}}:undefined});
    assert.equal((await f.client.refresh()).refundOperator,value===true);
  }
  const failed=fixture({override:call=>call.path==='/api/mini/operations/status'?{statusCode:503,data:{code:'UNAVAILABLE'}}:undefined});
  assert.equal((await failed.client.refresh()).refundOperator,false);
  const destinations=[],page=pageFixture(failed.client,{navigateTo:options=>destinations.push(options.url)});
  page.openRefundOperations();assert.equal(destinations.length,0);
  page.setData({refundOperator:true,busy:false,loading:false});page.openRefundOperations();
  assert.deepEqual(destinations,['/pages/refund-ops/index']);page.onHide();page.openRefundOperations();assert.equal(destinations.length,1);
});

test('an account change during operation discovery is not hidden as an ordinary unavailable feature', async () => {
  let changed=false;const f=fixture({override:call=>{
    if(call.path==='/api/mini/operations/status'&&!changed){changed=true;f.switchAccount('other');return {statusCode:401,data:{code:'AUTH_SESSION_EXPIRED'}};}
  }});
  await assert.rejects(f.client.refresh(),error=>error.code==='XPAY_ACCOUNT_CHANGED');
});

test('service facts only display published operator, documents, providers and bounded retention; incomplete facts stay unavailable', () => {
  const complete = serviceInformation(facts()); assert.equal(complete.available, true); assert.equal(complete.operator, 'Synthetic Operator');
  for (const mutate of [value => { delete value.operatorName; }, value => { value.status = 'pending_company_approval'; },
    value => { value.supportContact = ''; }, value => { value.privacyPolicyUrl = 'http://example.test/privacy'; },
    value => { value.aiServices[0].filingReference = ''; }, value => { value.retention.sourceHours = 0; }]) {
    const value = facts(); mutate(value); assert.equal(serviceInformation(value).available, false);
  }
  const missing = serviceInformation(null); assert.equal(missing.operator, 'REDACTED_COMPANY_NAME');
  assert.equal(missing.support, 'REDACTED_COMPANY_CONTACT_EMAIL'); assert.equal(missing.available, false); assert.deepEqual(missing.suppliers, []);
});

test('approved public support is visible and copyable without endpoint configuration, login or any API request', async () => {
  const copied = [];
  const client = createServiceClient({ setClipboardData: options => { copied.push(options.data); options.success({}); },
    login: () => assert.fail('public contact does not require login'), request: () => assert.fail('public contact does not call an API') }, undefined);
  await client.copySupport();
  assert.deepEqual(copied, ['REDACTED_COMPANY_CONTACT_EMAIL']);
  const unavailable = client.unavailableInformation();
  assert.equal(unavailable.available, false); assert.equal(unavailable.supportSource, 'public-config');
  assert.equal(unavailable.documents.every(document => !document.available && !document.url), true);
  assert.deepEqual(unavailable.suppliers, []); assert.equal(unavailable.sourceHours, null); assert.equal(unavailable.resultHours, null);
});

test('definitely unaccepted reports restore only a prior valid receipt and preserve unknown, other-account and payment records', async () => {
  const prior = { kind: 'complaint', state: 'submitted', ticketId: received.ticketId, createdAt: received.createdAt };
  const unrelated = [['lyx-service-report:other', { kind: 'account_deletion', state: 'unconfirmed' }],
    ['lyx-payment-pending:buyer', { idempotencyKey: 'original-order-key' }]];
  for (const code of ['REPORT_SUBMISSION_DISABLED', 'INVALID_REPORT_CATEGORY', 'INVALID_REPORT_DESCRIPTION',
    'INVALID_REPORT_CONTACT', 'REPORT_RATE_LIMITED']) {
    for (const previous of [undefined, prior, { kind: 'complaint', state: 'unconfirmed' }]) {
      const storage = new Map(unrelated.map(([key, value]) => [key, structuredClone(value)]));
      if (previous) storage.set('lyx-service-report:buyer', structuredClone(previous));
      const f = fixture({ storage, override: call => call.path === '/api/reports'
        ? { statusCode: code === 'REPORT_SUBMISSION_DISABLED' ? 503 : code === 'REPORT_RATE_LIMITED' ? 429 : 400, data: { code } } : undefined });
      await assert.rejects(f.client.submitReport(report), error => error.code === (previous?.state !== 'unconfirmed'
        && code === 'REPORT_SUBMISSION_DISABLED' ? 'REPORT_SUBMISSION_DISABLED' : 'SERVICE_REPORT_UNCONFIRMED'));
      assert.deepEqual(storage.get('lyx-service-report:buyer'), previous);
      assert.equal(f.calls.filter(call => call.path === '/api/reports').length, previous?.state === 'unconfirmed' ? 0 : 1);
      for (const [key, value] of unrelated) assert.deepEqual(storage.get(key), value);
    }
  }
});

test('failed service lookup keeps the confirmed email visible on the page and never claims approved service', async () => {
  const f = fixture({ override: call => { if (call.path === '/api/public/compliance') throw new Error('synthetic API unavailable'); } });
  const page = pageFixture(f.client); await page.onLoad(); await page.copySupport();
  assert.equal(page.data.support, 'REDACTED_COMPANY_CONTACT_EMAIL'); assert.equal(page.data.operator, 'REDACTED_COMPANY_NAME');
  assert.equal(page.data.available, false); assert.match(page.data.notice, /公开客服仍可联系/);
  assert.deepEqual(f.copied, ['REDACTED_COMPANY_CONTACT_EMAIL']); assert.deepEqual(page.data.suppliers, []);
});

test('server-published support has priority and a later outage does not silently switch the contact', async () => {
  let unavailable = false;
  const f = fixture({ override: call => { if (unavailable && call.path === '/api/public/compliance') throw new Error('synthetic API unavailable'); } });
  const page = pageFixture(f.client); await page.onLoad();
  assert.equal(page.data.support, 'support@example.test'); assert.equal(page.data.supportSource, 'server');
  unavailable = true; await page.refresh(); await page.copySupport();
  assert.equal(page.data.support, 'support@example.test'); assert.equal(page.data.operator, 'Synthetic Operator');
  assert.equal(page.data.supportSource, 'server'); assert.equal(page.data.available, false);
  assert.deepEqual(f.copied, ['support@example.test']);
});

test('document URLs reject credentials, insecure schemes, IPs, local names, fragments and script-like strings', () => {
  for (const value of ['http://example.test/a', 'javascript:alert(1)', 'https://REDACTED_USER:REDACTED_PASSWORD@example.test/a', 'https://127.0.0.1/a',
    'https://[::1]/a', 'https://localhost/a', 'https://service.internal/a', 'https://example.test/#token', 'https://example.test\\@evil.test',
    'https://example.test:8080/a', 'https://example.test/\nsecret', 'https://-bad.test/a']) assert.equal(publicHttps(value), null, value);
  assert.equal(publicHttps('https://example.test:443/terms?v=2'), 'https://example.test:443/terms?v=2');
});

test('public protocols copy only snapshot URLs and native privacy opens without a webview', async () => {
  const f = fixture(); await f.client.refresh();
  await f.client.copyDocument('privacyPolicyUrl'); await f.client.copySupport(); await f.client.openPrivacyContract();
  assert.deepEqual(f.copied, ['https://example.test/privacy', 'support@example.test']); assert.equal(f.privacyCalls(), 1);
  await assert.rejects(f.client.copyDocument('https://evil.test'), error => error.code === 'SERVICE_DOCUMENT_UNAVAILABLE');
  assert.equal(f.calls.some(call => call.path === '/api/reports'), false);
});

test('minimal complaint submits once and validates a 202 receipt without storing sensitive description or contact', async () => {
  const f = fixture(); const receipt = await f.client.submitReport({ ...report, contact: 'private-test-contact' });
  assert.deepEqual(receipt, { kind: 'complaint', state: 'submitted', ticketId: received.ticketId, createdAt: received.createdAt });
  const posted = f.calls.filter(call => call.path === '/api/reports'); assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].data, { ...report, contact: 'private-test-contact' });
  assert.equal(JSON.stringify([...f.storage]).includes(report.description), false); assert.equal(JSON.stringify([...f.storage]).includes('private-test-contact'), false);
  assert.deepEqual((await f.client.refresh()).receipt, receipt);
});

test('invalid or overlong complaint fields never call the API', async () => {
  const f = fixture();
  for (const value of [{ ...report, category: 'refund' }, { ...report, description: '太短' },
    { ...report, description: 'a'.repeat(2001) }, { ...report, contact: 'a'.repeat(201) }]) {
    await assert.rejects(f.client.submitReport(value), error => error.code === 'SERVICE_REPORT_INVALID');
  }
  assert.equal(f.calls.length, 0);
});

test('lost response retains only an account-scoped unresolved marker and never auto-replays or reports success', async () => {
  const storage = new Map([['lyx-payment-pending:buyer', { orderId: 'order1' }], ['lyx-service-report:other', { kind: 'complaint', state: 'unconfirmed' }]]);
  const f = fixture({ storage, override: call => { if (call.path === '/api/reports') throw new Error('synthetic connection lost'); } });
  await assert.rejects(f.client.submitReport(report), error => error.code === 'SERVICE_REPORT_UNCONFIRMED');
  const reopened = createServiceClient(f.wx, endpoint);
  assert.equal((await reopened.refresh()).receipt.state, 'unconfirmed');
  await assert.rejects(reopened.submitReport(report), error => error.code === 'SERVICE_REPORT_UNCONFIRMED');
  assert.equal(f.calls.filter(call => call.path === '/api/reports').length, 1);
  assert.deepEqual(storage.get('lyx-payment-pending:buyer'), { orderId: 'order1' }); assert.equal(storage.has('lyx-service-report:other'), true);
});

test('missing or non-submitted receipt never becomes success', async () => {
  for (const data of [{}, { ...received, status: 'resolved' }, { ...received, ticketId: 'https://private.test/x' }, { ...received, createdAt: 'not-a-date' }]) {
    const f = fixture({ override: call => call.path === '/api/reports' ? { statusCode: 202, data: { code: 0, data } } : null });
    await assert.rejects(f.client.submitReport(report), error => error.code === 'SERVICE_REPORT_UNCONFIRMED');
    assert.equal(f.storage.get('lyx-service-report:buyer').state, 'unconfirmed');
  }
});

test('a definite validation rejection permits a correction but a generic server failure stays uncertain', async () => {
  const f = fixture({ override: call => call.path === '/api/reports' ? { statusCode: 429, data: { code: 'REPORT_RATE_LIMITED' } } : null });
  await assert.rejects(f.client.submitReport(report)); assert.equal(f.storage.has('lyx-service-report:buyer'), false);
  const uncertain = fixture({ override: call => call.path === '/api/reports' ? { statusCode: 503, data: { code: 'REPORT_STORAGE_UNAVAILABLE' } } : null });
  await assert.rejects(uncertain.client.submitReport(report)); assert.equal(uncertain.storage.get('lyx-service-report:buyer').state, 'unconfirmed');
});

test('the in-flight report lock rejects a second submission before any second POST', async () => {
  const waiting = deferred(), started = deferred();
  const f = fixture({ override: async call => { if (call.path === '/api/reports') { started.resolve(); await waiting.promise; } } });
  const first = f.client.submitReport(report); await started.promise;
  await assert.rejects(f.client.submitReport(report), error => error.code === 'SERVICE_REPORT_BUSY'); waiting.resolve(); await first;
  assert.equal(f.calls.filter(call => call.path === '/api/reports').length, 1);
});

test('account switching never displays or modifies another account receipt', async () => {
  const storage = new Map([['lyx-service-report:other', { kind: 'complaint', state: 'submitted', ticketId: received.ticketId, createdAt: received.createdAt }]]);
  const f = fixture({ storage }); assert.equal((await f.client.refresh()).receipt, null);
  f.switchAccount('other'); await assert.rejects(f.client.refresh(), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(storage.get('lyx-service-report:other').ticketId, received.ticketId);
  const reopened = createServiceClient(f.wx, endpoint); assert.equal((await reopened.refresh()).receipt.ticketId, received.ticketId);
});

test('401 followed by a different WeChat account never replays the complaint under the new account', async () => {
  let f;
  f = fixture({ override: call => {
    if (call.path === '/api/reports') { f.switchAccount('other'); return { statusCode: 401, data: { code: 'AUTH_EXPIRED' } }; }
  } });
  await assert.rejects(f.client.submitReport(report), error => error.code === 'XPAY_ACCOUNT_CHANGED');
  assert.equal(f.calls.filter(call => call.path === '/api/reports').length, 1);
  assert.equal(f.storage.get('lyx-service-report:buyer').state, 'unconfirmed');
  assert.equal(f.storage.has('lyx-service-report:other'), false);
});

test('deletion is an explicitly confirmed request ticket, never DELETE or local rights/pending clearing', async () => {
  const f = fixture({ storage: new Map([['lyx-payment-pending:buyer', { orderId: 'order1' }], ['lyx-creation-pending:buyer', { jobId: 'photo1' }]]) });
  for (const confirmation of [{}, { informationConfirmed: true }, { applicationConfirmed: true }]) {
    assert.throws(() => f.client.requestAccountDeletion(confirmation), error => error.code === 'SERVICE_DELETION_CONFIRMATION_REQUIRED');
  }
  const receipt = await f.client.requestAccountDeletion({ informationConfirmed: true, applicationConfirmed: true });
  assert.equal(receipt.kind, 'account_deletion'); assert.equal(receipt.state, 'submitted');
  const request = f.calls.find(call => call.path === '/api/reports'); assert.equal(request.data.category, 'other');
  assert.match(request.data.description, /不授权清空或放弃权益/); assert.match(request.data.description, /交易和安全记录/);
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(f.storage.has('lyx-payment-pending:buyer'), true); assert.equal(f.storage.has('lyx-creation-pending:buyer'), true);
});

test('either deletion confirmation can cancel without invoking the client', async () => {
  for (const answers of [[false], [true, false]]) {
    let calls = 0, modal = 0;
    const page = pageFixture({ requestAccountDeletion: async () => { calls++; } }, { showModal: options => options.success({ confirm: answers[modal++] }) });
    await page.requestDeletion(); assert.equal(calls, 0); assert.equal(page.data.busy, false); assert.equal(modal, answers.length);
  }
});

test('both explicit confirmations submit one request while double-taps are locked through confirmation', async () => {
  let calls = 0; const modals = [];
  const page = pageFixture({ requestAccountDeletion: async values => { calls++; assert.equal(values.applicationConfirmed, true); return { kind: 'account_deletion', state: 'submitted', ...received }; } },
    { showModal: options => modals.push(options) });
  const operation = page.requestDeletion(); assert.equal(page.data.busy, true); await page.requestDeletion(); assert.equal(modals.length, 1);
  modals[0].success({ confirm: true }); await Promise.resolve(); assert.equal(modals.length, 2);
  modals[1].success({ confirm: true }); await operation;
  assert.equal(calls, 1); assert.equal(page.data.busy, false); assert.match(page.data.reportNotice, /尚未确认注销/);
});

test('hiding clears sensitive form and receipt, and a late response cannot repopulate the hidden page', async () => {
  const waiting = deferred();
  const page = pageFixture({ submitReport: () => waiting.promise });
  page.setData({ description: report.description, contact: 'private-test', receipt: { ticketId: 'previous' } });
  const operation = page.submitReport(); page.onHide(); waiting.resolve({ ...received, state: 'submitted', kind: 'complaint' }); await operation;
  assert.equal(page.data.description, ''); assert.equal(page.data.contact, ''); assert.equal(page.data.receipt, null); assert.equal(page.data.reportNotice, '');
});

test('a hidden page cannot complete either pending deletion confirmation or submit an application', async () => {
  for (const hideAt of [0, 1]) {
    const modals = []; let submissions = 0;
    const page = pageFixture({ requestAccountDeletion: async () => { submissions++; } }, { showModal: options => modals.push(options) });
    const operation = page.requestDeletion();
    if (hideAt === 1) { modals[0].success({ confirm: true }); await Promise.resolve(); }
    assert.equal(modals.length, hideAt + 1); page.onHide();
    modals[hideAt].success({ confirm: true }); await operation;
    assert.equal(submissions, 0); assert.equal(modals.length, hideAt + 1); assert.equal(page.data.busy, false);
  }
});

test('an old refresh cannot reveal its receipt after hiding and returning to the page', async () => {
  const waiting = deferred();
  const page = pageFixture({ refresh: () => waiting.promise });
  const refreshing = page.refresh(); page.onHide(); await page.onShow();
  waiting.resolve({ ...serviceInformation(facts()), receipt: { kind: 'complaint', state: 'submitted', ...received } });
  await refreshing;
  assert.equal(page.data.receipt, null); assert.equal(page.data.reportNotice, ''); assert.equal(page.data.loading, false);
});

test('unloading prevents a delayed submitted receipt from updating the closed page', async () => {
  const waiting = deferred();
  const page = pageFixture({ submitReport: () => waiting.promise });
  page.setData({ description: report.description, contact: 'synthetic-private-contact' });
  const operation = page.submitReport(); page.onUnload();
  const afterUnload = structuredClone(page.data);
  waiting.resolve({ kind: 'complaint', state: 'submitted', ...received }); await operation;
  assert.deepEqual(page.data, afterUnload); assert.equal(page.client, null);
});

test('switching WeChat accounts between deletion confirmations cannot submit for the newly active account', async () => {
  const f = fixture(), modals = [];
  const page = pageFixture(f.client, { showModal: options => modals.push(options) });
  await page.onLoad();
  const operation = page.requestDeletion(); modals[0].success({ confirm: true }); await Promise.resolve();
  f.switchAccount('other'); modals[1].success({ confirm: true }); await operation;
  assert.equal(f.calls.some(call => call.path === '/api/reports'), false);
  assert.equal(f.storage.size, 0); assert.equal(page.data.receipt, null);
  assert.match(page.data.reportNotice, /账号已变化/);
});

test('service markup exposes no arbitrary webview, payment action or invented support contact', () => {
  const markup = readFileSync(new URL('../../miniprogram/pages/service/index.wxml', import.meta.url), 'utf8');
  assert.doesNotMatch(markup, /<web-view|requestVirtualPayment|tel:|mailto:|https:\/\//);
  assert.match(markup, /申请不等于注销完成/); assert.match(markup, /依法/); assert.match(markup, /尚未公开/);
});
