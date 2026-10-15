import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLegalBundle, validateLegalBundle, legalSnippet, legalSiteConfiguration,
  legalActivationScript, createLegalJournal, deployLegalAction, LEGAL_TARGET, LEGAL_PAGES } from '../scripts/deploy-mini-legal-static.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-legal-fixture-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const appRoot = path.join(temporary, 'app'), directory = path.join(appRoot, 'public/mini/legal');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of LEGAL_PAGES) fs.writeFileSync(path.join(directory, name), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body { color: #333 }</style></head><body>${name} 服务说明</body></html>`);
  fs.writeFileSync(path.join(directory, '.env'), 'PRIVATE_FIXTURE_SHOULD_NOT_BE_INCLUDED');
  const bundle = buildLegalBundle({ appRoot });
  const journal = createLegalJournal(bundle, path.join(temporary, 'journal'));
  return { temporary, appRoot, directory, bundle, journal };
}
function packed(payload) {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  return { bytes, sha256: hash(bytes) };
}
function transfer(bundle, overrides = {}) {
  return { Invocations: { Invocation: [{ InvokeId: 'f-fixtureUpload', Name: `.leyanxiu-mini-legal-${bundle.sha256}.json.gz`,
    TargetDir: '/var/www', FileMode: '0600', FileOwner: 'root', FileGroup: 'root', InvocationStatus: 'Success',
    InvokeInstances: { InvokeInstance: [{ InstanceId: LEGAL_TARGET.instanceId, InvocationStatus: 'Success', ErrorCode: '', ErrorInfo: '' }] }, ...overrides }] } };
}
function execution(id, output, overrides = {}) {
  return { Invocation: { InvocationResults: { InvocationResult: [{ InstanceId: LEGAL_TARGET.instanceId,
    InvokeId: id, InvocationStatus: 'Success', ExitCode: 0, Output: output, ...overrides }] } } };
}

test('deterministic package contains exactly three reviewed HTML files, never adjacent private files', t => {
  const f = fixture(t), same = buildLegalBundle({ appRoot: f.appRoot });
  assert.equal(same.sha256, f.bundle.sha256);
  assert.deepEqual(same.bytes, f.bundle.bytes);
  const payload = validateLegalBundle(same.bytes, same.sha256);
  assert.deepEqual(Object.keys(payload.files), LEGAL_PAGES);
  assert.equal(JSON.stringify(payload).includes('PRIVATE_FIXTURE'), false);
  for (const name of LEGAL_PAGES) assert.equal(payload.manifest.files[name].sha256, hash(fs.readFileSync(path.join(f.directory, name))));
  assert.ok(same.bytes.toString('base64').length <= 32000);
});

test('manifest path, target, page hashes, canonical base64 and decompression limits reject corruption', t => {
  const f = fixture(t), original = validateLegalBundle(f.bundle.bytes, f.bundle.sha256);
  const changes = [
    p => { p.files['../private.env'] = p.files['terms.html']; },
    p => { delete p.files['terms.html']; },
    p => { p.manifest.instanceId = 'i-other'; },
    p => { p.manifest.directory = '/etc/nginx'; },
    p => { p.manifest.files['privacy.html'].sha256 = '0'.repeat(64); },
    p => { p.files['privacy.html'].content += '\n'; },
    p => { p.files['privacy.html'].bytes++; },
    p => { p.manifest.secret = 'PRIVATE_FIXTURE'; },
  ];
  for (const change of changes) {
    const value = structuredClone(original); change(value); const b = packed(value);
    assert.throws(() => validateLegalBundle(b.bytes, b.sha256));
  }
  assert.throws(() => validateLegalBundle(f.bundle.bytes, '0'.repeat(64)));
  const bomb = zlib.gzipSync(Buffer.alloc(500000, 65));
  assert.throws(() => validateLegalBundle(bomb, hash(bomb)), /BUNDLE_INVALID/);
});

test('external resources, oversized files and symlink directory cannot be bundled', t => {
  const f = fixture(t);
  const filename = path.join(f.directory, 'privacy.html');
  fs.writeFileSync(filename, '<!doctype html><html><link rel="stylesheet" href="legal.css"></html>');
  assert.throws(() => buildLegalBundle({ appRoot: f.appRoot }), /HTML_REJECTED/);
  fs.writeFileSync(filename, Buffer.alloc(65537));
  assert.throws(() => buildLegalBundle({ appRoot: f.appRoot }), /FILE_REJECTED/);
  const elsewhere = path.join(f.temporary, 'other'); fs.renameSync(f.directory, elsewhere);
  fs.symlinkSync(elsewhere, f.directory, 'junction');
  assert.throws(() => buildLegalBundle({ appRoot: f.appRoot }), /SYMLINK_REJECTED/);
});

test('Nginx diff is one include only; exact routes inherit HSTS explicitly and allow only GET/HEAD', () => {
  const original = fs.readFileSync(new URL('../deploy/nginx.app-account.conf.example', import.meta.url));
  const next = legalSiteConfiguration(original), text = next.toString();
  assert.equal(hash(original), LEGAL_TARGET.originalSha256);
  const newline = original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  assert.equal(hash(Buffer.from(text.replace(`    include ${LEGAL_TARGET.snippet};${newline}`, ''))), hash(original));
  assert.throws(() => legalSiteConfiguration(Buffer.from(original.toString().replace('3300', '4400'))), /CONFIG_CHANGED/);
  const snippet = legalSnippet();
  assert.equal((snippet.match(/location = /g) || []).length, 3);
  for (const name of LEGAL_PAGES) assert.ok(snippet.includes(`location = /mini/legal/${name} {`));
  for (const directive of ['limit_except GET HEAD { deny all; }', 'autoindex off;', 'disable_symlinks on;', 'charset utf-8;', '"nosniff" always;', '"no-cache" always;', '"max-age=31536000" always;']) assert.equal(snippet.split(directive).length - 1, 3);
  assert.equal(snippet.includes('proxy_pass'), false);
});

test('embedded Python compiles for activation/status and limits all writes to static paths', t => {
  const f = fixture(t);
  const python = process.env.PYTHON_PATH || 'python';
  for (const inspectOnly of [false, true]) {
    const script = legalActivationScript(f.bundle, { inspectOnly });
    const code = script.split("<<'MINI_LEGAL_PY'\n")[1].split('\nMINI_LEGAL_PY')[0];
    execFileSync(python, ['-c', 'import sys; compile(sys.stdin.read(),"mini-legal-command","exec")'], { input: code, encoding: 'utf8' });
    const shell = process.env.MINI_LEGAL_TEST_SHELL || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/usr/bin/sh.exe');
    if (fs.existsSync(shell)) execFileSync(shell, ['-n'], { input: script, encoding: 'utf8' });
    assert.ok(script.includes('os.O_EXCL|os.O_NOFOLLOW'));
    assert.ok(script.includes("backup=read(WORK/'original.conf'"));
    assert.ok(script.includes("replace_site(backup,M['siteSha256'])"));
    assert.ok(script.includes("run(['nginx','-t'],'rollback-test')"));
    assert.ok(script.includes("run(['systemctl','reload','nginx'],'rollback-reload')"));
    assert.ok(!script.includes('rmtree') && !script.includes('rm -') && !script.includes('unlink('));
    assert.ok(!script.includes('systemctl restart') && !script.includes('mysql') && !script.includes('server.env'));
    assert.ok(Buffer.byteLength(script) < 24000);
  }
});

test('durable phases precede mutations, SendFile uses f- and the dedicated result API, activation happens once', async t => {
  const f = fixture(t), calls = [];
  const requestImpl = async (action, params) => {
    calls.push(action);
    if (action === 'SendFile') {
      assert.equal(f.journal.read().phase, 'upload_uncertain');
      assert.equal(params.Overwrite, 'false'); assert.equal(params.FileMode, '0600');
      assert.equal(params.TargetDir, '/var/www'); assert.equal(params['InstanceId.1'], LEGAL_TARGET.instanceId);
      assert.ok(params.Content.length <= 32000);
      assert.equal(hash(Buffer.from(params.Content, 'base64')), f.bundle.sha256);
      return { InvokeId: 'f-fixtureUpload' };
    }
    if (action === 'DescribeSendFileResults') { assert.equal(params.InvokeId, 'f-fixtureUpload'); return transfer(f.bundle); }
    if (action === 'RunCommand') {
      assert.equal(f.journal.read().phase, 'activate_uncertain');
      assert.equal(params.Username, 'root'); assert.equal(params.KeepCommand, 'false');
      return { InvokeId: 't-fixtureActivate' };
    }
    assert.equal(action, 'DescribeInvocationResults');
    return execution(params.InvokeId, `PRIVATE_ERROR_SHOULD_NOT_BE_OUTPUT\nMINI_LEGAL_ACTIVE ${f.bundle.sha256}`);
  };
  const run = action => deployLegalAction(action, { ...f, requestImpl });
  await assert.rejects(run('activate'), /UPLOAD_CONFIRMATION_REQUIRED/);
  assert.equal((await run('upload')).phase, 'upload_submitted');
  await assert.rejects(run('upload'), /NO_MUTATION_RETRY/);
  assert.equal((await run('status')).phase, 'uploaded');
  assert.equal((await run('activate')).phase, 'activate_submitted');
  await assert.rejects(run('activate'), /UPLOAD_CONFIRMATION_REQUIRED/);
  const result = await run('status'); assert.equal(result.phase, 'active');
  assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR'), false);
  assert.deepEqual(calls, ['SendFile','DescribeSendFileResults','RunCommand','DescribeInvocationResults']);
});

test('ambiguous upload is never retried; read-only inspection may recover its exact hash', async t => {
  const f = fixture(t); let sends = 0;
  const fail = async () => { sends++; throw new Error('PRIVATE_CREDENTIAL_MUST_NOT_BE_PRINTED'); };
  await assert.rejects(deployLegalAction('upload', { ...f, requestImpl: fail }));
  assert.equal(f.journal.read().phase, 'upload_uncertain');
  await assert.rejects(deployLegalAction('upload', { ...f, requestImpl: fail }), /NO_MUTATION_RETRY/);
  assert.equal(sends, 1);
  const requestImpl = async (action, params) => {
    if (action === 'RunCommand') {
      assert.ok(Buffer.from(params.CommandContent, 'base64').toString().includes('INSPECT=True'));
      return { InvokeId: 't-fixtureInspect' };
    }
    return execution(params.InvokeId, `MINI_LEGAL_UPLOADED ${f.bundle.sha256}`);
  };
  assert.equal((await deployLegalAction('status', { ...f, requestImpl })).invocationId, 't-fixtureInspect');
  assert.equal((await deployLegalAction('status', { ...f, requestImpl })).phase, 'uploaded');
});

test('status refuses another instance, altered destination, unconfirmed errors and arbitrary output', async t => {
  const f = fixture(t);
  f.journal.write({ ...f.journal.read(), phase: 'upload_submitted', uploadInvokeId: 'f-fixtureUpload' });
  await assert.rejects(deployLegalAction('status', { ...f, requestImpl: async () => transfer(f.bundle, { TargetDir: '/other' }) }), /SCOPE_REJECTED/);
  const failed = transfer(f.bundle); failed.Invocations.Invocation[0].InvokeInstances.InvokeInstance[0].ErrorInfo = 'PRIVATE_FAILURE';
  const result = await deployLegalAction('status', { ...f, requestImpl: async () => failed });
  assert.equal(result.phase, 'upload_submitted'); assert.equal(JSON.stringify(result).includes('PRIVATE_FAILURE'), false);
  f.journal.write({ ...f.journal.read(), phase: 'activate_submitted', activateInvokeId: 't-fixtureActivate' });
  const unknown = await deployLegalAction('status', { ...f, requestImpl: async () => execution('t-fixtureActivate', `MINI_LEGAL_ACTIVE ${'0'.repeat(64)}\nSECRET`) });
  assert.equal(unknown.phase, 'activate_submitted'); assert.deepEqual(unknown.codes, []);
  await assert.rejects(deployLegalAction('status', { ...f, requestImpl: async () => execution('t-fixtureActivate', '', { InstanceId: 'i-other' }) }), /SCOPE_REJECTED/);
  const rollback = await deployLegalAction('status', { ...f, requestImpl: async () => execution('t-fixtureActivate', `MINI_LEGAL_ROLLED_BACK ${f.bundle.sha256}`, { InvocationStatus: 'Failed', ExitCode: 1 }) });
  assert.equal(rollback.phase, 'rolled_back');
});

test('import and default local plan never load credentials or perform network requests', () => {
  const moduleUrl = new URL('../scripts/deploy-mini-legal-static.mjs', import.meta.url);
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const original=fs.readFileSync;
    fs.readFileSync=function(name,...rest){if(String(name).includes('.env'))throw new Error('PRIVATE_READ_FORBIDDEN');return original.call(this,name,...rest);};
    globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN');};
    await import(${JSON.stringify(moduleUrl.href)});
  `], { encoding: 'utf8' });
  assert.equal(result, '');
  const planned = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const original=fs.readFileSync;
    fs.readFileSync=function(name,...rest){if(String(name).includes('.env'))throw new Error('PRIVATE_READ_FORBIDDEN');return original.call(this,name,...rest);};
    globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN');};
    process.argv=[process.execPath,${JSON.stringify(fileURLToPath(moduleUrl))}];
    await import(${JSON.stringify(moduleUrl.href)});
  `], { encoding: 'utf8' });
  assert.equal(JSON.parse(planned).readsCredentials, false);
  assert.equal(JSON.parse(planned).sendsRemoteCommand, false);
});

test('exclusive durable mutation claims prevent stale state or concurrent callers from dispatching twice', async t => {
  const f = fixture(t); const before = f.journal.read(); let sent = 0;
  const requestImpl = async () => { sent++; return { InvokeId: 'f-fixtureUpload' }; };
  await deployLegalAction('upload', { ...f, requestImpl });
  f.journal.write(before); // Even a stale phase cannot erase the persistent claim.
  await assert.rejects(deployLegalAction('upload', { ...f, requestImpl }), /EEXIST/);
  assert.equal(sent, 1);
});
