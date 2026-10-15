import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { buildLegalBundle, validateLegalBundle, legalRefreshScript, createLegalJournal,
  deployLegalAction, LEGAL_REFRESH_BASELINE, LEGAL_REFRESH_TARGET_SHA256, LEGAL_PAGES, LEGAL_TARGET } from '../scripts/deploy-mini-legal-static.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bundle = buildLegalBundle();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-legal-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicDir = path.join(root, 'public'), work = path.join(root, 'work');
  fs.mkdirSync(publicDir, { mode: 0o755 });
  const site = path.join(root, 'site.conf'), snippet = path.join(root, 'snippet.conf');
  fs.writeFileSync(site, 'existing site config\n', { mode: 0o644 });
  fs.writeFileSync(snippet, 'existing snippet\n', { mode: 0o644 });
  const oldFiles = {};
  for (const name of LEGAL_PAGES) {
    const bytes = Buffer.from(`previous reviewed page: ${name}\n`);
    fs.writeFileSync(path.join(publicDir, name), bytes, { mode: 0o644 });
    oldFiles[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  const payload = validateLegalBundle(bundle.bytes, bundle.sha256);
  payload.manifest = { ...payload.manifest, site, snippet, directory: publicDir,
    siteSha256: hash(fs.readFileSync(site)), snippetSha256: hash(fs.readFileSync(snippet)) };
  const baseline = { ...LEGAL_REFRESH_BASELINE, siteSha256: payload.manifest.siteSha256,
    snippetSha256: payload.manifest.snippetSha256, files: oldFiles };
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload))), incoming = path.join(root, 'incoming.gz');
  fs.writeFileSync(incoming, bytes, { mode: 0o600 });
  return { root, publicDir, work, site, snippet, incoming, payload, baseline, sha256: hash(bytes) };
}

// Execute the production Python transaction in a temporary filesystem. Only the
// fixture paths and hashes differ. Windows lacks Unix ownership/mode and dir-fsync
// semantics, so that adapter preserves regular-file/symlink/hardlink checks while
// the generated Linux permissions and no-follow checks are tested separately.
function run(f, { inspect = false, failReplaceAt = 0 } = {}) {
  const script = legalRefreshScript(bundle, { inspectOnly: inspect });
  const production = script.split("<<'MINI_LEGAL_PY'\n")[1].split('\nMINI_LEGAL_PY')[0];
  const adapter = `
M=json.loads(${JSON.stringify(JSON.stringify(f.payload.manifest))})
OLD=json.loads(${JSON.stringify(JSON.stringify(f.baseline))})
SHA='${f.sha256}'
FIXTURE=pathlib.Path(${JSON.stringify(f.root.replaceAll('\\', '/'))})
INCOMING=pathlib.Path(${JSON.stringify(f.incoming.replaceAll('\\', '/'))})
WORK=pathlib.Path(${JSON.stringify(f.work.replaceAll('\\', '/'))})
SITE=pathlib.Path(M['site']); PUBLIC=pathlib.Path(M['directory']); SNIPPET=pathlib.Path(M['snippet'])
def fixture_scope(p):
 assert pathlib.Path(p).resolve().is_relative_to(FIXTURE.resolve())
def fixture_check(p,kind='dir',mode=None):
 fixture_scope(p); s=p.lstat()
 assert not stat.S_ISLNK(s.st_mode)
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
original_replace=os.replace
replace_calls=0
def fixture_replace(source,target):
 global replace_calls
 fixture_scope(source); fixture_scope(target); replace_calls+=1
 if replace_calls==${failReplaceAt}: raise RuntimeError('injected replace failure')
 original_replace(source,target)
os.replace=fixture_replace
`;
  const marker = 'work_owned=False; backups_ready=False';
  assert.equal(production.split(marker).length, 2);
  return spawnSync(process.env.PYTHON_PATH || 'python', ['-'], {
    input: production.replace(marker, adapter + '\n' + marker), encoding: 'utf8', timeout: 10000,
  });
}
function pageHashes(f) {
  return Object.fromEntries(LEGAL_PAGES.map(name => [name, hash(fs.readFileSync(path.join(f.publicDir, name)))]));
}
function expectedHashes(entries) { return Object.fromEntries(Object.entries(entries).map(([name, e]) => [name, e.sha256])); }
function tree(f) {
  const snapshot = {};
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else snapshot[path.relative(f.root, filename)] = { hash: hash(fs.readFileSync(filename)), mtime: fs.statSync(filename).mtimeMs };
    }
  };
  visit(f.root); return snapshot;
}

test('refresh pins the reviewed old evidence, current Nginx hashes and exact new bundle', () => {
  assert.equal(bundle.sha256, LEGAL_REFRESH_TARGET_SHA256);
  const evidence = JSON.parse(fs.readFileSync(new URL('../evidence/mini-legal-static-2026-10-12.json', import.meta.url)));
  assert.equal(LEGAL_REFRESH_BASELINE.bundleSha256, evidence.bundleSha256);
  for (const page of evidence.newPages) assert.deepEqual(LEGAL_REFRESH_BASELINE.files[path.posix.basename(page.path)], { bytes: page.bytes, sha256: page.sha256 });
  assert.equal(bundle.manifest.siteSha256, LEGAL_REFRESH_BASELINE.siteSha256);
  assert.equal(bundle.manifest.snippetSha256, LEGAL_REFRESH_BASELINE.snippetSha256);
  assert.throws(() => legalRefreshScript({ ...bundle, sha256: '0'.repeat(64) }));
  for (const inspectOnly of [false, true]) {
    const script = legalRefreshScript(bundle, { inspectOnly });
    const code = script.split("<<'MINI_LEGAL_PY'\n")[1].split('\nMINI_LEGAL_PY')[0];
    execFileSync(process.env.PYTHON_PATH || 'python', ['-c', 'import sys; compile(sys.stdin.read(),"refresh","exec")'], { input: code });
    assert.ok(!/subprocess|systemctl|nginx','-t|replace_site|PUBLIC\.mkdir|SNIPPET_BYTES|server\.env/.test(script));
    assert.ok(script.includes('os.O_EXCL|os.O_NOFOLLOW') && script.includes('s.st_uid==0') && script.includes('s.st_nlink==1'));
    assert.ok(script.includes('os.replace(staged,PUBLIC/name)') && script.includes('checked_backups(); backups_ready=True'));
    assert.ok(Buffer.byteLength(script) < 24000);
  }
});

test('refresh backs up every old page and replaces only the three pages without changing Nginx', t => {
  const f = fixture(t), config = [fs.readFileSync(f.site), fs.readFileSync(f.snippet)];
  const result = run(f); assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /MINI_LEGAL_REFRESHED/);
  assert.deepEqual(pageHashes(f), expectedHashes(f.payload.manifest.files));
  for (const [name, entry] of Object.entries(f.baseline.files)) assert.equal(hash(fs.readFileSync(path.join(f.work, 'backup', name))), entry.sha256);
  assert.deepEqual([fs.readFileSync(f.site), fs.readFileSync(f.snippet)], config);
  fs.unlinkSync(path.join(f.work, 'result.json')); // Power loss after replacement, before receipt.
  const before = tree(f), inspection = run(f, { inspect: true });
  assert.equal(inspection.status, 0, inspection.stderr + inspection.stdout); assert.match(inspection.stdout, /MINI_LEGAL_REFRESHED/);
  assert.deepEqual(tree(f), before); // status must not write even a recovery receipt.
  const replay = run(f); assert.equal(replay.status, 1); assert.deepEqual(tree(f), before);
});

test('old-page or installed-configuration drift fails before creating backups or replacing pages', t => {
  for (const target of ['page', 'site', 'snippet']) {
    const f = fixture(t), file = target === 'page' ? path.join(f.publicDir, LEGAL_PAGES[0]) : f[target];
    fs.appendFileSync(file, 'changed independently');
    const before = tree(f), result = run(f);
    assert.equal(result.status, 1); assert.match(result.stdout, /MINI_LEGAL_REFRESH_FAILED/);
    assert.equal(fs.existsSync(f.work), false); assert.deepEqual(tree(f), before);
  }
});

test('failure after the first replacement restores the exact old pages from durable backups', t => {
  const f = fixture(t), result = run(f, { failReplaceAt: 2 });
  assert.equal(result.status, 1); assert.match(result.stdout, /MINI_LEGAL_REFRESH_ROLLED_BACK/);
  assert.deepEqual(pageHashes(f), expectedHashes(f.baseline.files));
  const before = tree(f), inspection = run(f, { inspect: true });
  assert.equal(inspection.status, 0); assert.match(inspection.stdout, /MINI_LEGAL_REFRESH_ROLLED_BACK/);
  assert.deepEqual(tree(f), before);
});

test('status reports mixed pages without writing or replaying; hardlinks fail closed', t => {
  const f = fixture(t); assert.equal(run(f).status, 0);
  fs.copyFileSync(path.join(f.work, 'backup', LEGAL_PAGES[0]), path.join(f.publicDir, LEGAL_PAGES[0]));
  const before = tree(f), inspection = run(f, { inspect: true });
  assert.equal(inspection.status, 0); assert.match(inspection.stdout, /MINI_LEGAL_REFRESH_PARTIAL/); assert.deepEqual(tree(f), before);
  const linked = fixture(t); fs.linkSync(path.join(linked.publicDir, LEGAL_PAGES[0]), path.join(linked.root, 'extra-link'));
  assert.equal(run(linked).status, 1); assert.equal(fs.existsSync(linked.work), false);
});

test('an ambiguous update permits only read-only status recovery and never a second dispatch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-legal-refresh-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = createLegalJournal(bundle, root, { mode: 'refresh' });
  journal.write({ ...journal.read(), phase: 'uploaded', uploadInvokeId: 'f-testUpload' });
  const calls = [], commands = [];
  const requestImpl = async (action, parameters) => {
    calls.push(action);
    if (action === 'RunCommand') {
      const script = Buffer.from(parameters.CommandContent, 'base64').toString(); commands.push(script);
      return { InvokeId: script.includes('INSPECT=True') ? 't-inspect' : 't-refresh' };
    }
    assert.equal(action, 'DescribeInvocationResults');
    const inspecting = parameters.InvokeId === 't-inspect';
    return { Invocation: { InvocationResults: { InvocationResult: [{ InstanceId: LEGAL_TARGET.instanceId, InvokeId: parameters.InvokeId,
      InvocationStatus: inspecting ? 'Success' : 'Timeout', ExitCode: inspecting ? 0 : 1,
      Output: inspecting ? `PRIVATE_TEXT\nMINI_LEGAL_REFRESHED ${bundle.sha256}` : 'PRIVATE_TIMEOUT' }] } } };
  };
  const invoke = action => deployLegalAction(action, { bundle, journal, requestImpl });
  await assert.rejects(invoke('activate'), /INSTALL_JOURNAL_REQUIRED/);
  assert.equal((await invoke('refresh')).phase, 'activate_submitted');
  assert.equal((await invoke('status')).phase, 'activate_uncertain');
  await assert.rejects(invoke('refresh'), /UPLOAD_CONFIRMATION_REQUIRED/);
  await invoke('status');
  const result = await invoke('status'); assert.equal(result.phase, 'active');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(commands.filter(script => script.includes('INSPECT=False')).length, 1);
  assert.equal(commands.filter(script => script.includes('INSPECT=True')).length, 1);
  journal.write({ ...journal.read(), phase: 'uploaded' });
  await assert.rejects(invoke('refresh'), /EEXIST/);
  assert.deepEqual(calls, ['RunCommand', 'DescribeInvocationResults', 'RunCommand', 'DescribeInvocationResults']);
});
