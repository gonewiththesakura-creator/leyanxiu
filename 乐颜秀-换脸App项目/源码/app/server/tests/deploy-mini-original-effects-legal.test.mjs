import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLegalBundle, validateLegalBundle, LEGAL_TARGET, LEGAL_PAGES } from '../scripts/deploy-mini-legal-static.mjs';
import { ORIGINAL_LEGAL_REVIEW as review, buildOriginalLegalBundle, validateOriginalLegalBundle, originalLegalRefreshScript,
  originalLegalJournal, originalLegalAction, prepareOriginalEffectsFacts } from '../scripts/deploy-mini-original-effects-legal.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.PYTHON_PATH || 'python', bundle = buildOriginalLegalBundle();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-legal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public'), work = path.join(root, 'work'); fs.mkdirSync(publicDir);
  const old = validateLegalBundle(buildLegalBundle().bytes, review.baselineBundleSha256);
  for (const name of LEGAL_PAGES) fs.writeFileSync(path.join(publicDir, name), Buffer.from(old.files[name].content, 'base64'));
  const site = path.join(root, 'site.conf'), snippet = path.join(root, 'snippet.conf');
  fs.writeFileSync(site, 'unchanged site'); fs.writeFileSync(snippet, 'unchanged snippet');
  const payload = validateOriginalLegalBundle(bundle);
  payload.manifest = { ...payload.manifest, site, snippet, directory: publicDir,
    siteSha256: hash(fs.readFileSync(site)), snippetSha256: hash(fs.readFileSync(snippet)) };
  const baseline = { ...review, siteSha256: payload.manifest.siteSha256, snippetSha256: payload.manifest.snippetSha256 };
  const incoming = path.join(root, 'incoming.gz'), bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  fs.writeFileSync(incoming, bytes);
  return { root, publicDir, work, site, snippet, incoming, payload, baseline, sha256: hash(bytes) };
}
function tree(f) {
  const result = {};
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(filename);
    else result[path.relative(f.root, filename)] = { sha: hash(fs.readFileSync(filename)), mtime: fs.statSync(filename).mtimeMs };
  } }
  walk(f.root); return result;
}
// Run the actual generated transaction in isolated files. Windows lacks Unix
// ownership/directory fsync; only that adapter and fixture paths differ.
function run(f, { inspectOnly = false, failReceipt = false } = {}) {
  const production = originalLegalRefreshScript(bundle, { inspectOnly }).split("<<'ORIGINAL_LEGAL_PY'\n")[1].split('\nORIGINAL_LEGAL_PY')[0];
  const adapter = `
M=json.loads(${JSON.stringify(JSON.stringify(f.payload.manifest))})
OLD=json.loads(${JSON.stringify(JSON.stringify(f.baseline))})
SHA='${f.sha256}'
FIXTURE=pathlib.Path(${JSON.stringify(f.root.replaceAll('\\', '/'))})
INCOMING=pathlib.Path(${JSON.stringify(f.incoming.replaceAll('\\', '/'))}); WORK=pathlib.Path(${JSON.stringify(f.work.replaceAll('\\', '/'))})
SITE=pathlib.Path(M['site']); PUBLIC=pathlib.Path(M['directory']); SNIPPET=pathlib.Path(M['snippet'])
def fixture_scope(p): assert pathlib.Path(p).resolve().is_relative_to(FIXTURE.resolve())
def fixture_check(p,kind='dir',mode=None):
 fixture_scope(p); s=p.lstat(); assert not stat.S_ISLNK(s.st_mode)
 assert (stat.S_ISDIR(s.st_mode) if kind=='dir' else stat.S_ISREG(s.st_mode) and s.st_nlink==1)
 return s
def fixture_parents(p):
 fixture_scope(p)
 for parent in p.parents:
  if parent==FIXTURE: break
  fixture_check(parent)
check=fixture_check; parents=fixture_parents
if os.name=='nt':
 os.geteuid=lambda: 0
 os.O_NOFOLLOW=0
 sync_directory=lambda p: fixture_scope(p)
original_create=create
def fixture_create(p,b,mode):
 if ${failReceipt ? 'True' : 'False'} and p.name=='result.json': raise RuntimeError('injected receipt failure')
 original_create(p,b,mode)
create=fixture_create
`;
  const marker = 'work_owned=False; backup_ready=False'; assert.equal(production.split(marker).length, 2);
  return spawnSync(python, ['-'], { input: production.replace(marker, adapter + '\n' + marker), encoding: 'utf8', timeout: 10000 });
}

test('pins exact candidate and baseline without rewriting original sources, facts or historical deployment contract', () => {
  assert.equal(bundle.sha256, review.bundleSha256); assert.equal(bundle.bytes.length, 16198);
  assert.deepEqual(bundle.manifest.files, { ...review.files, 'terms.html': review.terms });
  assert.equal(buildLegalBundle().sha256, review.baselineBundleSha256);
  assert.throws(() => validateOriginalLegalBundle({ ...bundle, sha256: 'f'.repeat(64) }));
  assert.throws(() => validateOriginalLegalBundle({ ...bundle, manifest: { ...bundle.manifest, directory: '/etc' } }));
  for (const inspectOnly of [false, true]) {
    const script = originalLegalRefreshScript(bundle, { inspectOnly });
    const code = script.split("<<'ORIGINAL_LEGAL_PY'\n")[1].split('\nORIGINAL_LEGAL_PY')[0];
    execFileSync(python, ['-c', 'import sys; compile(sys.stdin.read(),"refresh","exec")'], { input: code });
    assert.doesNotMatch(script, /subprocess|systemctl|replace_site|server\.env|PUBLIC\.mkdir/);
    assert.match(script, /os\.O_EXCL\|os\.O_NOFOLLOW/); assert.match(script, /s\.st_uid==0/); assert.match(script, /s\.st_nlink==1/);
    assert.ok(Buffer.byteLength(script) < 24000);
  }
});
test('transaction only replaces terms, keeps original backup, and read-only status recovers missing receipt without writes', t => {
  const f = fixture(t), before = tree(f), result = run(f); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /ORIGINAL_LEGAL_ACTIVE/);
  assert.equal(hash(fs.readFileSync(path.join(f.publicDir, 'terms.html'))), review.terms.sha256);
  assert.equal(hash(fs.readFileSync(path.join(f.work, 'terms.backup'))), review.files['terms.html'].sha256);
  const after = tree(f);
  for (const name of ['site.conf', 'snippet.conf', 'public/privacy.html', 'public/third-parties.html']) {
    const key = name.replaceAll('/', path.sep); assert.deepEqual(after[key], before[key]);
  }
  fs.unlinkSync(path.join(f.work, 'result.json'));
  const noReceipt = tree(f), inspected = run(f, { inspectOnly: true }); assert.equal(inspected.status, 0); assert.match(inspected.stdout, /ORIGINAL_LEGAL_ACTIVE/);
  assert.deepEqual(tree(f), noReceipt); assert.equal(run(f).status, 1); assert.deepEqual(tree(f), noReceipt);
});
test('page, Nginx, hardlink and incoming drift refuse any page writes', t => {
  for (const kind of ['terms', 'privacy', 'site', 'snippet', 'incoming', 'hardlink']) {
    const f = fixture(t);
    if (kind === 'hardlink') fs.linkSync(path.join(f.publicDir, 'terms.html'), path.join(f.root, 'linked'));
    else fs.appendFileSync(kind === 'terms' || kind === 'privacy' ? path.join(f.publicDir, `${kind}.html`) : f[kind], 'drift');
    const before = tree(f), result = run(f); assert.equal(result.status, 1, kind); assert.equal(fs.existsSync(f.work), false);
    assert.deepEqual(tree(f), before);
  }
});
test('failure after atomic terms replacement restores exact original and leaves a read-only audit trail', t => {
  const f = fixture(t), result = run(f, { failReceipt: true }); assert.equal(result.status, 1); assert.match(result.stdout, /ORIGINAL_LEGAL_ROLLED_BACK/);
  assert.equal(hash(fs.readFileSync(path.join(f.publicDir, 'terms.html'))), review.files['terms.html'].sha256);
  const before = tree(f), inspection = run(f, { inspectOnly: true }); assert.equal(inspection.status, 0); assert.match(inspection.stdout, /ORIGINAL_LEGAL_ROLLED_BACK/);
  assert.deepEqual(tree(f), before);
});
function journal(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-legal-journal-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, journal: originalLegalJournal(bundle, { outputRoot: root, create: true }) };
}
test('exclusive new journal and write-ahead markers stop unknown upload and refresh replay', async t => {
  const { root, journal: j } = journal(t);
  assert.throws(() => originalLegalJournal(bundle, { outputRoot: root, create: true }), /EEXIST/);
  let calls = 0;
  const invoke = action => originalLegalAction(action, { bundle, journal: j, requestImpl: async () => { calls++; throw Error('PRIVATE_FAILURE'); } });
  await assert.rejects(invoke('upload')); assert.equal(j.read().phase, 'upload_uncertain');
  await assert.rejects(invoke('upload'), /NO_MUTATION_RETRY/); assert.equal(calls, 1);
  const old = j.read(); j.write({ ...old, phase: 'uploaded' }, old);
  await assert.rejects(invoke('refresh')); assert.equal(j.read().phase, 'refresh_uncertain');
  await assert.rejects(invoke('refresh'), /UPLOAD_CONFIRMATION_REQUIRED/); assert.equal(calls, 2);
  const unknown = j.read(); j.write({ ...unknown, phase: 'uploaded' }, unknown);
  await assert.rejects(invoke('refresh'), /EEXIST/); assert.equal(calls, 2);
});
test('failed intent persistence prevents remote dispatch', async t => {
  const { journal: j } = journal(t); let calls = 0;
  await assert.rejects(originalLegalAction('upload', { bundle, journal: { ...j, write() { throw Error('disk'); } }, requestImpl: async () => { calls++; } }));
  assert.equal(calls, 0); assert.equal(j.read().phase, 'prepared');
  await assert.rejects(originalLegalAction('upload', { bundle, journal: j, requestImpl: async () => { calls++; } }), /EEXIST/); assert.equal(calls, 0);
});
test('supported APIs verify target and output hashes; status never replays unknown writes and does not expose provider output', async t => {
  const { journal: j } = journal(t), calls = [];
  const requestImpl = async (action, args) => {
    calls.push(action);
    if (action === 'SendFile') { assert.equal(j.read().phase, 'upload_uncertain'); assert.equal(args['InstanceId.1'], LEGAL_TARGET.instanceId);
      assert.equal(args.Overwrite, 'false'); assert.equal(args.ClientToken, bundle.sha256); return { InvokeId: 'f-upload' }; }
    if (action === 'DescribeSendFileResults') return { Invocations: { Invocation: [{ InvokeId: 'f-upload',
      Name: `.leyanxiu-original-effects-legal-${bundle.sha256}.json.gz`, TargetDir: '/var/www', FileOwner: 'root', FileGroup: 'root', FileMode: '0600',
      InvocationStatus: 'Success', InvokeInstances: { InvokeInstance: [{ InstanceId: LEGAL_TARGET.instanceId, InvocationStatus: 'Success' }] } }] } };
    if (action === 'RunCommand') { const script = Buffer.from(args.CommandContent, 'base64').toString(); assert.equal(args['InstanceId.1'], LEGAL_TARGET.instanceId);
      if (script.includes('INSPECT=False')) { assert.equal(j.read().phase, 'refresh_uncertain'); return { InvokeId: 't-refresh' }; }
      return { InvokeId: 't-inspect' }; }
    assert.equal(action, 'DescribeInvocationResults');
    return { Invocation: { InvocationResults: { InvocationResult: [{ InstanceId: LEGAL_TARGET.instanceId, InvokeId: args.InvokeId,
      InvocationStatus: 'Success', ExitCode: 0, Output: `PRIVATE_SECRET\nORIGINAL_LEGAL_ACTIVE ${bundle.sha256}` }] } } };
  };
  const invoke = action => originalLegalAction(action, { bundle, journal: j, requestImpl });
  await invoke('upload'); assert.equal((await invoke('status')).phase, 'uploaded');
  await invoke('refresh'); const result = await invoke('status'); assert.equal(result.phase, 'active'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET/);
  await invoke('inspect'); assert.equal((await invoke('status')).phase, 'active');
  assert.deepEqual(calls, ['SendFile', 'DescribeSendFileResults', 'RunCommand', 'DescribeInvocationResults', 'RunCommand', 'DescribeInvocationResults']);
  await assert.rejects(invoke('refresh')); await assert.rejects(invoke('upload'));
});
test('facts preparation changes exactly one variable and retains original products, policy, payments and all other public facts', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(app, 'server/docs/production-config/natural-avatar-merchant-public-facts-2026-10-13.json')));
  const variables = { XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_PRODUCTS_JSON: 'SYNTHETIC_ORIGINAL_PRODUCT', XPAY_SESSION_ENCRYPTION_KEY: 'PRIVATE_KEY',
    PHOTO_PRODUCTION_CONFIG_SHA256: 'PRIVATE_POLICY_PIN', PRIVACY_POLICY_URL: facts.publicDocuments.privacyPolicyUrl,
    USER_AGREEMENT_URL: facts.publicDocuments.userAgreementUrl, THIRD_PARTY_LIST_URL: facts.publicDocuments.thirdPartyListUrl,
    RETENTION_SUPPLIER_POLICY: facts.retentionSupplierPolicy, PIPIA_REFERENCE: facts.pipiaReference,
    AI_SERVICE_DISCLOSURES_JSON: JSON.stringify(facts.aiServiceDisclosures) };
  const result = prepareOriginalEffectsFacts(variables);
  assert.deepEqual(Object.keys(result.variables), Object.keys(variables));
  for (const key of Object.keys(variables)) if (key !== 'AI_SERVICE_DISCLOSURES_JSON') assert.equal(result.variables[key], variables[key]);
  assert.match(JSON.parse(result.variables.AI_SERVICE_DISCLOSURES_JSON)[0].purpose, /现代漫画像或温润水彩像/);
  assert.doesNotMatch(JSON.stringify(result.summary), /PRIVATE|SYNTHETIC_ORIGINAL_PRODUCT/);
  for (const change of [{ XPAY_MODE: 'public' }, { XPAY_ENV: '1' }, { RETENTION_SUPPLIER_POLICY: 'changed' }, { AI_SERVICE_DISCLOSURES_JSON: '[]' }]) {
    assert.throws(() => prepareOriginalEffectsFacts({ ...variables, ...change }));
  }
});
test('wrong instance, conflicting or wrong-hash success output and failed results never confirm publication', async t => {
  for (const variant of ['instance', 'invocation', 'hash', 'conflict', 'failed', 'exit']) {
    const { journal: j } = journal(t), before = j.read();
    j.write({ ...before, phase: 'refresh_submitted', refreshInvokeId: 't-refresh' }, before);
    const result = { InstanceId: LEGAL_TARGET.instanceId, InvokeId: 't-refresh', InvocationStatus: 'Success', ExitCode: 0,
      Output: `ORIGINAL_LEGAL_ACTIVE ${bundle.sha256}` };
    if (variant === 'instance') result.InstanceId = 'other';
    if (variant === 'invocation') result.InvokeId = 't-other';
    if (variant === 'hash') result.Output = `ORIGINAL_LEGAL_ACTIVE ${'f'.repeat(64)}`;
    if (variant === 'conflict') result.Output += `\nORIGINAL_LEGAL_ROLLED_BACK ${bundle.sha256}`;
    if (variant === 'failed') result.InvocationStatus = 'Failed';
    if (variant === 'exit') result.ExitCode = 1;
    const action = originalLegalAction('status', { bundle, journal: j, requestImpl: async (method) => {
      assert.equal(method, 'DescribeInvocationResults'); return { Invocation: { InvocationResults: { InvocationResult: [result] } } };
    } });
    if (['instance', 'invocation'].includes(variant)) await assert.rejects(action, /STATUS_SCOPE_REJECTED/);
    else assert.equal((await action).phase, 'refresh_submitted');
    assert.equal(j.read().phase, 'refresh_submitted');
  }
});
test('default CLI plan reads no credentials and has no network', () => {
  const script = fileURLToPath(new URL('../scripts/deploy-mini-original-effects-legal.mjs', import.meta.url));
  const program = `import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const read=fs.readFileSync;fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('PRIVATE_READ');return read.call(this,p,...args)};
globalThis.fetch=()=>{throw Error('NETWORK')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK')};
process.argv=[process.execPath,${JSON.stringify(script)},'plan'];await import(${JSON.stringify(new URL('../scripts/deploy-mini-original-effects-legal.mjs', import.meta.url).href)});`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
  assert.equal(result.sha256, review.bundleSha256); assert.equal(result.sendsRemoteCommand, false); assert.equal(result.readsCredentials, false);
  assert.deepEqual(result.changedPages, ['terms.html']);
});
