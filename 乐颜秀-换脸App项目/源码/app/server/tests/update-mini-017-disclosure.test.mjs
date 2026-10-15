import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { merchantTestProduct } from '../scripts/prepare-mini-production-merchant-test.mjs';
import { disclosure017Target as target, disclosure017Plan, prepareDisclosure017, submitDisclosure017,
  disclosure017Status, validateDisclosure017Snapshot, safeDisclosureCloudError } from '../scripts/update-mini-017-disclosure.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), clone = value => structuredClone(value);
const read = name => fs.readFileSync(path.join(server, name));
const facts = JSON.parse(read('docs/production-config/natural-avatar-merchant-public-facts-2026-10-13.json'));
const vars = { WECHAT_APP_ID: target.appId, XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_ENABLED: 'true',
  XPAY_RECONCILE_ENABLED: 'true', XPAY_DB_BACKEND: 'mysql', XPAY_PRODUCTS_JSON: JSON.stringify([merchantTestProduct]),
  XPAY_TEST_USER_IDS: 'usr_11111111-1111-1111-1111-111111111111', XPAY_REFUND_OPERATOR_USER_IDS: 'usr_22222222-2222-2222-2222-222222222222',
  XPAY_SESSION_ENCRYPTION_KEY: 'PRIVATE_SYNTHETIC_KEY', XPAY_APP_KEY: 'PRIVATE_SYNTHETIC_KEY',
  PRIVACY_POLICY_URL: facts.publicDocuments.privacyPolicyUrl, USER_AGREEMENT_URL: facts.publicDocuments.userAgreementUrl,
  THIRD_PARTY_LIST_URL: facts.publicDocuments.thirdPartyListUrl, RETENTION_SUPPLIER_POLICY: facts.retentionSupplierPolicy,
  PIPIA_REFERENCE: facts.pipiaReference, AI_SERVICE_DISCLOSURES_JSON: JSON.stringify(facts.aiServiceDisclosures),
  PHOTO_PRODUCTION_CONFIG_SHA256: target.policySha256, PHOTO_PRODUCTION_ACCEPTANCE_SHA256: target.acceptanceSha256,
  PHOTO_PRODUCTION_CONFIG_BASE64: read('docs/production-config/original-effects-merchant-policy-2026-10-15.json').toString('base64'),
  PHOTO_PRODUCTION_ACCEPTANCE_BASE64: read('evidence/mini-photo-original-effects-acceptance-bundle-2026-10-15.json').toString('base64'),
};
const detail = (name, variables = vars) => ({ VersionName: name, ServerName: 'buildtest', EnvId: target.envId, Status: 'normal',
  EnvParams: JSON.stringify(variables), ContainerPort: 3000, MinNum: 0, MaxNum: 1, Cpu: 0.25, Mem: 0.5, ImageUrl: 'PRIVATE_IMAGE',
  IsPublic: true, RequestId: 'dynamic', VersionIP: 'dynamic' });
function snapshot() { return {
  base: { openAccessTypes: ['MINIAPP'], publicAccess: false, minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, envParams: JSON.stringify(vars) },
  domain: { AccessTypes: ['MINIAPP'], RequestId: 'dynamic' },
  current: detail('buildtest-016', { old: 'source' }), candidate: detail('buildtest-017'),
  historicalCurrent: detail('buildtest-013', { old: 'historical' }), historicalPrevious: detail('buildtest-014', { old: 'historical' }),
  versions: ['013', '014', '016', '017'].map(n => ({ VersionName: `buildtest-${n}`, Status: 'normal', FlowRatio: 0, Remark: `keep-${n}` })),
  task: { id: target.taskId, status: 'running', envId: target.envId, serverName: 'buildtest' },
  order: { isExist: true, releaseOrderInfo: { id: target.releaseOrderId, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: 'buildtest-017' }, trafficType: 'URL_PARAMS',
    trafficTypeValues: [{ key: 'synthetic', value: 'PRIVATE_ROUTE_VALUE' }], flowRatio: 0 } },
}; }
let prepared;
test.before(async () => { await prepareDisclosure017({}, { read: () => null, write: r => { prepared = clone(r); }, inspect: async () => snapshot() }); });
function operation({ fail, noApply, receiptFail } = {}) {
  let record = clone(prepared); const current = snapshot(), calls = [];
  const inspect = async () => clone(current);
  const adapter = { CloudAPI: { async tcbModifyCloudBaseRunServerVersion(args) {
    assert.equal(record.phase, 'update_requested'); calls.push(args);
    assert.deepEqual(Object.keys(args).sort(), ['region', 'envId', 'serverName', 'versionName', 'envParams'].sort());
    assert.equal(args.versionName, 'buildtest-017'); assert.equal(args.envId, target.envId);
    if (!noApply) current.candidate.EnvParams = args.envParams;
    if (fail) throw Error('PRIVATE_NETWORK_FAILURE');
    return { result: 'synthetic-ack-not-proof' };
  } } };
  const options = { read: () => clone(record), write(next, prior) { assert.deepEqual(prior, record);
    if (receiptFail && next.phase === 'submitted') throw Error('disk'); record = clone(next); }, inspect };
  return { adapter, options, current, calls, read: () => clone(record), run: () => submitDisclosure017(adapter, options) };
}
test('prepare creates an independent exact one-field change preserving product, policy, private routing and source configuration', () => {
  assert.deepEqual(Object.keys(prepared.variables), Object.keys(vars));
  assert.deepEqual(Object.keys(vars).filter(k => vars[k] !== prepared.variables[k]), ['AI_SERVICE_DISCLOSURES_JSON']);
  assert.deepEqual(prepared.before, snapshot()); assert.equal(prepared.phase, 'prepared');
  assert.match(JSON.parse(prepared.variables.AI_SERVICE_DISCLOSURES_JSON)[0].purpose, /现代漫画像或温润水彩像/);
});
test('target, pending route, traffic, merchant, pins and base mismatch reject before prepare persistence', async () => {
  for (const change of [s => { s.order.releaseOrderInfo.id++; }, s => { s.task.id++; }, s => { s.task.status = 'finished'; },
    s => { s.order.releaseOrderInfo.releaseStatus = 'success'; }, s => { s.order.releaseOrderInfo.trafficType = 'HEADER'; },
    s => { s.order.releaseOrderInfo.trafficTypeValues = []; }, s => { s.order.releaseOrderInfo.trafficTypeValues[0].value = ''; },
    s => { s.current.VersionName = 'buildtest-015'; }, s => { s.candidate.Status = 'building'; },
    s => { s.versions[0].FlowRatio = 100; }, s => { s.base.maxNum = 2; }, s => { s.base.envParams = '{}'; },
    s => { const e = JSON.parse(s.candidate.EnvParams); e.XPAY_PRODUCTS_JSON = '[]'; s.candidate.EnvParams = JSON.stringify(e); },
    s => { const e = JSON.parse(s.candidate.EnvParams); e.PHOTO_PRODUCTION_CONFIG_BASE64 += 'AA'; s.candidate.EnvParams = JSON.stringify(e); }]) {
    const s = snapshot(); change(s); let writes = 0;
    await assert.rejects(prepareDisclosure017({}, { read: () => null, write: () => { writes++; }, inspect: async () => s })); assert.equal(writes, 0);
  }
});
test('submit makes one known version-specific request, then verifies candidate only changed while base and routing stay exact', async () => {
  const op = operation(), result = await op.run(); assert.equal(op.calls.length, 1); assert.equal(op.read().phase, 'submitted');
  assert.equal(result.controlPlane.exactAfter, true); assert.equal(result.controlPlane.baseIntentionallyUnchanged, true);
  assert.equal(result.controlPlane.futureDeploymentMustExplicitlyRetainUpdatedFacts, true); assert.equal(result.runtimeDisclosureVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|EnvParams|BASE64|usr_/);
  await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(op.calls.length, 1);
});
test('unknown response and failed durable receipt never retry, but read-only exact status can observe application', async () => {
  for (const flags of [{ fail: true }, { receiptFail: true }]) {
    const op = operation(flags); await assert.rejects(op.run()); assert.equal(op.read().phase, 'update_requested');
    await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/);
    const result = await disclosure017Status({}, op.read(), op.options.inspect); assert.equal(result.controlPlane.exactAfter, true);
    assert.equal(result.controlPlane.observationIsFinalRequestOutcome, false); assert.equal(op.calls.length, 1);
  }
  const unapplied = operation({ noApply: true }); const result = await unapplied.run();
  assert.equal(result.controlPlane.exactBefore, true); assert.equal(result.controlPlane.exactAfter, false); assert.equal(result.retryAllowed, false);
});
test('failed intent persistence prevents update and any postprepare drift blocks before remote mutation', async () => {
  const op = operation(); op.options.write = () => { throw Error('disk'); }; await assert.rejects(op.run()); assert.equal(op.calls.length, 0);
  for (const change of [s => { s.current.ImageUrl = 'other'; }, s => { s.candidate.ImageUrl = 'other'; },
    s => { s.order.releaseOrderInfo.trafficTypeValues[0].value = 'changed'; }, s => { s.base.envParams = '{}'; },
    s => { s.versions[0].Remark = 'changed'; }]) {
    const changed = operation(); change(changed.current); await assert.rejects(changed.run()); assert.equal(changed.calls.length, 0);
  }
});
test('status does not certify env-only success when unrelated base, source, traffic or candidate resource changes', async () => {
  for (const change of [s => { s.current.ImageUrl = 'other'; }, s => { s.candidate.MaxNum = 2; },
    s => { s.base.envParams = s.candidate.EnvParams; }, s => { s.order.releaseOrderInfo.trafficTypeValues[0].value = 'changed'; }]) {
    const op = operation(); await op.run(); change(op.current);
    const result = await disclosure017Status({}, op.read(), op.options.inspect); assert.equal(result.controlPlane.exactAfter, false);
  }
});
test('running-order timestamps are volatile metadata, while identity and route changes still block', async () => {
  const op = operation();
  const result = await op.run(); assert.equal(result.controlPlane.exactAfter, true);
  const order = op.current.order.releaseOrderInfo;
  order.createdTime = '2026-10-15T03:00:00.000Z'; order.updatedTime = '2026-10-15T03:01:00.000Z';
  order.currentVersion.updatedTime = '2026-10-15T03:02:00.000Z'; order.releaseVersion.updatedTime = '2026-10-15T03:03:00.000Z';
  assert.equal((await disclosure017Status({}, op.read(), op.options.inspect)).controlPlane.exactAfter, true);
  order.releaseVersion.versionName = 'buildtest-018';
  assert.equal((await disclosure017Status({}, op.read(), op.options.inspect)).controlPlane.exactAfter, false);
});
test('persisted JSON and SDK own undefined base fields compare equally, but every defined value still rejects', async () => {
  const stored = JSON.parse(JSON.stringify(prepared));
  delete stored.before.base.publicAccess;
  delete stored.before.base.operatorRemark;
  const live = snapshot(); delete live.base.publicAccess;
  live.base.publicAccess = undefined; live.base.operatorRemark = undefined;
  const status = await disclosure017Status({}, stored, async () => live);
  assert.equal(status.controlPlane.exactBefore, true);
  assert.equal(status.controlPlane.beforeComparisons.base, true);
  assert.equal(status.controlPlane.baseIntentionallyUnchanged, true);
  assert.ok(Object.values(status.controlPlane.beforeComparisons).every(value => value === true));
  assert.ok(Object.values(status.controlPlane.beforeComparisons).every(value => typeof value === 'boolean'));
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|EnvParams|BASE64|operatorRemark|publicAccess/);
  for (const [key, value] of [['publicAccess', null], ['publicAccess', false], ['publicAccess', true],
    ['operatorRemark', null], ['operatorRemark', false], ['operatorRemark', ''], ['operatorRemark', 'changed']]) {
    const changed = structuredClone(live); changed.base[key] = value;
    const changedStatus = await disclosure017Status({}, stored, async () => changed);
    assert.equal(changedStatus.controlPlane.exactBefore, false);
    assert.equal(changedStatus.controlPlane.beforeComparisons.base, false);
  }
  let saved = stored, calls = 0;
  await submitDisclosure017({ CloudAPI: { async tcbModifyCloudBaseRunServerVersion(args) {
    calls++; live.candidate.EnvParams = args.envParams; return { result: 'synthetic-ack' };
  } } }, { read: () => saved, write: next => { saved = JSON.parse(JSON.stringify(next)); }, inspect: async () => live });
  assert.equal(calls, 1);
});
test('installed official SDK serializes only region, target and full EnvParams, using an entirely fake transport', async () => {
  const require = createRequire('REDACTED_LOCAL_USER_PATH/AppData/Local/leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli/package.json');
  const sdk = require('@wxcloud/cloudapi'); let observed;
  sdk.setDefaultAppID('synthetic-app'); sdk.setTransactType(sdk.TransactType.IDE);
  sdk.setRequest(async options => { observed = { identity: options.identity, payload: JSON.parse(options.postdata) };
    return JSON.stringify({ Response: { Result: 'synthetic', RequestId: 'synthetic' } }); });
  await sdk.tcbModifyCloudBaseRunServerVersion({ region: 'ap-shanghai', envId: 'synthetic-env', serverName: 'synthetic', versionName: 'synthetic-017', envParams: '{"TEST":"synthetic"}' });
  assert.equal(observed.identity.action, 'ModifyCloudBaseRunServerVersion'); assert.equal(observed.identity.service, 'tcb');
  assert.equal(observed.identity.version, '2018-06-08');
  assert.deepEqual(observed.payload, { Region: 'ap-shanghai', EnvId: 'synthetic-env', ServerName: 'synthetic', VersionName: 'synthetic-017', EnvParams: '{"TEST":"synthetic"}' });
});
test('import/plan is inert and never reads private files or requests network', () => {
  const script = fileURLToPath(new URL('../scripts/update-mini-017-disclosure.mjs', import.meta.url));
  const program = `import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const read=fs.readFileSync;fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('PRIVATE_READ');return read.call(this,p,...args)};
globalThis.fetch=()=>{throw Error('NETWORK')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK')};
process.argv=[process.execPath,${JSON.stringify(script)},'plan'];await import(${JSON.stringify(new URL('../scripts/update-mini-017-disclosure.mjs', import.meta.url).href)});`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })), disclosure017Plan);
});
test('future cloud errors retain safe classification without exposing arbitrary messages, request config or bodies', async () => {
  const diagnostic = safeDisclosureCloudError(Object.assign(new Error('UnauthorizedOperation.SourceDenied, PRIVATE_KEY source forbidden'), {
    config: { headers: { key: 'PRIVATE_KEY' }, data: vars }, response: { status: 403, data: 'PRIVATE_BODY' } }));
  assert.equal(diagnostic.sdkFamily, 'UnauthorizedOperation'); assert.equal(diagnostic.sourceRestrictionMentioned, true);
  assert.equal(diagnostic.httpStatus, 403); assert.equal(diagnostic.retryAllowed, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|EnvParams|BASE64|usr_/);
  assert.equal(safeDisclosureCloudError(Error('Base resp abnormal, {"ret":80210,"msg":"PRIVATE"}')).gatewayRet, 80210);
  assert.equal(safeDisclosureCloudError(Error('12345 PRIVATE_BODY')).gatewayErrCode, 12345);
  assert.equal(safeDisclosureCloudError(Object.assign(Error('PRIVATE'), { code: 'ETIMEDOUT' })).networkCode, 'ETIMEDOUT');
  const op = operation({ fail: true });
  await assert.rejects(op.run(), error => error.code === 'DISCLOSURE_017_UPDATE_REQUEST_UNCONFIRMED'
    && error.safeDiagnostic.retryAllowed === false && !JSON.stringify(error).includes('PRIVATE_NETWORK_FAILURE'));
  assert.equal(op.read().phase, 'update_requested'); assert.equal(op.calls.length, 1);
  await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(op.calls.length, 1);
});
