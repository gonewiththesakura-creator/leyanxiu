import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPhotoCandidate, verifyPhotoCandidateBundle } from '../scripts/build-mini-photo-candidate.mjs';
import { candidateSourceFiles, candidateDependencies, projectCandidateLock } from '../scripts/plan-mini-photo-candidate.mjs';

const server = fileURLToPath(new URL('../', import.meta.url));
const packaging = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'runtime-image.json', 'README.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (root, relative, content) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  for (const file of [...candidateSourceFiles, 'package-lock.json', ...packaging.map(name => 'deploy/mini-photo-candidate/' + name)]) {
    write(source, file, fs.readFileSync(path.join(server, file)));
  }
  const output = path.join(directory, 'bundle');
  return { directory, source, output, build: () => buildPhotoCandidate({ root: source, output }) };
}

test('explicit whitelist creates and verifies a complete local context without private inputs or install execution', t => {
  const f = fixture(t);
  for (const file of ['.env', '.env.mini-payment', 'data/private.sqlite', 'evidence/private.json', 'node_modules/private.js', 'output/private.jpg']) {
    write(f.source, file, 'PRIVATE_SYNTHETIC_CANARY_NEVER_PACK');
  }
  const result = f.build(); assert.equal(result.verified, true); assert.equal(result.deployable, false); assert.equal(result.deployed, false);
  assert.equal(result.includesPrivateConfig, false); assert.equal(result.scope, 'mini-photo-candidate-local');
  assert.equal(result.defaults.env, 1); assert.equal(result.defaults.sandboxMayCharge, true);
  for (const key of ['purchaseEnabled', 'generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled', 'productionPaymentsEnabled']) assert.equal(result.defaults[key], false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.equal(result.manifestSha256, sha(fs.readFileSync(path.join(f.output, 'manifest.json'))));
  assert.equal(manifest.files.length, candidateSourceFiles.length + packaging.length);
  assert.ok(manifest.files.some(file => file.path === 'photo-jobs/candidate-public.js'));
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(f.output, file.path));
    assert.equal(file.bytes, bytes.length); assert.equal(file.sha256, sha(bytes));
    assert.equal(bytes.includes(Buffer.from('PRIVATE_SYNTHETIC_CANARY_NEVER_PACK')), false);
    assert.doesNotMatch(file.path, /(?:^|\/)(?:\.env|data|evidence|output|node_modules|android)(?:[./]|$)/);
  }
  assert.equal(fs.existsSync(path.join(f.output, 'index.js')), false);
  assert.equal(fs.existsSync(path.join(f.output, 'payments/virtual/mini-sandbox-server.js')), false);
  const projected = projectCandidateLock(JSON.parse(fs.readFileSync(path.join(server, 'package-lock.json'))));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, 'package-lock.json'))), projected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, 'package.json'))).dependencies, candidateDependencies);
  assert.equal(manifest.dependencyLock.packages, 116); assert.equal(manifest.dependencyLock.installed, false);
  assert.equal(manifest.runtime.imageBuilt, false); assert.equal(manifest.runtime.linuxNpmCiVerified, false);
  assert.deepEqual(verifyPhotoCandidateBundle(f.output), result);
});

test('existing output is never merged or overwritten and a missing source leaves no partial output', t => {
  const f = fixture(t); fs.mkdirSync(f.output); write(f.output, 'original.txt', 'keep');
  assert.throws(f.build, /PHOTO_BUILD_NEW_ABSOLUTE_DIRECTORY_REQUIRED/);
  assert.equal(fs.readFileSync(path.join(f.output, 'original.txt'), 'utf8'), 'keep');
  const other = path.join(f.directory, 'missing-input-output');
  for (const relative of ['photo-jobs/candidate-server.js', 'photo-jobs/candidate-public.js']) {
    const input = path.join(f.source, relative); const original = fs.readFileSync(input); fs.unlinkSync(input);
    assert.throws(() => buildPhotoCandidate({ root: f.source, output: other }), /PHOTO_BUILD_REGULAR_FILE_REQUIRED/);
    assert.equal(fs.existsSync(other), false); fs.writeFileSync(input, original);
  }
  assert.throws(() => buildPhotoCandidate({ root: f.source, output: 'relative' }), /PHOTO_BUILD_NEW_ABSOLUTE_DIRECTORY_REQUIRED/);
});

test('unlisted or computed entry imports fail before creating the bundle', t => {
  const f = fixture(t);
  for (const text of ["import '../index.js';", "import 'dotenv/config';", 'await import(process.env.HOST);', "require('ali-oss');"]) {
    write(f.source, 'photo-jobs/candidate-server.js', text);
    assert.throws(f.build, /PHOTO_PLAN_/); assert.equal(fs.existsSync(f.output), false);
  }
});

test('a linked input directory cannot silently import external sources', t => {
  const f = fixture(t); const original = path.join(f.source, 'photo-jobs'); const elsewhere = path.join(f.directory, 'elsewhere');
  fs.renameSync(original, elsewhere); fs.symlinkSync(elsewhere, original, 'junction');
  assert.throws(f.build, /PHOTO_BUILD_REGULAR_FILE_REQUIRED/); assert.equal(fs.existsSync(f.output), false);
});

test('dependency drift or installation hooks require another review and cannot silently regenerate the stored lock', t => {
  const f = fixture(t); const file = path.join(f.source, 'package-lock.json'); const baseline = JSON.parse(fs.readFileSync(file));
  const altered = structuredClone(baseline); altered.packages['node_modules/ali-oss'].hasInstallScript = true;
  fs.writeFileSync(file, JSON.stringify(altered)); assert.throws(f.build, /PHOTO_PLAN_LOCK_ENTRY_UNREVIEWED/);
  fs.writeFileSync(file, JSON.stringify(baseline));
  const projectedPath = path.join(f.source, 'deploy/mini-photo-candidate/package-lock.json');
  const projected = JSON.parse(fs.readFileSync(projectedPath)); projected.packages['node_modules/ali-oss'].license = 'changed-local-metadata';
  fs.writeFileSync(projectedPath, JSON.stringify(projected)); assert.throws(f.build, /PHOTO_BUILD_SOURCE_LOCK_DRIFT/);
  assert.equal(fs.existsSync(f.output), false);
});

test('appended permissive Docker flags, root user or broad context COPY fail closed', t => {
  const f = fixture(t); const file = path.join(f.source, 'deploy/mini-photo-candidate/Dockerfile'); const baseline = fs.readFileSync(file, 'utf8');
  for (const appended of ['\nENV XPAY_MODE=sandbox\n', '\nENV PHOTO_CANDIDATE_PROCESS_ENABLED=true\n', '\nUSER root\n', '\nCOPY . .\n', '\nENV DEBUG=*\n']) {
    fs.writeFileSync(file, baseline + appended); assert.throws(f.build, /PHOTO_BUILD_DOCKER_UNREVIEWED/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('verification rejects extra private files, changed bytes, altered scope and false container proof', t => {
  const f = fixture(t); f.build(); const file = path.join(f.output, 'manifest.json'); const original = fs.readFileSync(file);
  write(f.output, '.env', 'synthetic'); assert.throws(() => verifyPhotoCandidateBundle(f.output), /PHOTO_BUILD_FILE_SET_CHANGED/); fs.unlinkSync(path.join(f.output, '.env'));
  const source = path.join(f.output, 'photo-jobs/candidate-host.js'); const bytes = fs.readFileSync(source);
  fs.appendFileSync(source, '\n// unexpected change\n'); assert.throws(() => verifyPhotoCandidateBundle(f.output), /PHOTO_BUILD_FILE_HASH_MISMATCH/); fs.writeFileSync(source, bytes);
  for (const mutate of [m => { m.scope = 'sandbox-only'; }, m => { m.defaults.purchaseEnabled = true; }, m => { m.runtime.imageBuilt = true; },
    m => { m.files[0].path = '../outside'; }]) {
    const manifest = JSON.parse(original); mutate(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyPhotoCandidateBundle(f.output), /PHOTO_BUILD_MANIFEST_INVALID/);
  }
  fs.writeFileSync(file, original); assert.equal(verifyPhotoCandidateBundle(f.output).verified, true);
});

test('CLI verification is local and refuses execution/deployment flags', t => {
  const f = fixture(t); f.build(); const script = fileURLToPath(new URL('../scripts/build-mini-photo-candidate.mjs', import.meta.url));
  const verified = spawnSync(process.execPath, [script, '--verify', f.output], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).verified, true);
  for (const flag of ['--execute', '--deploy', '--install']) {
    const invalid = spawnSync(process.execPath, [script, flag, f.output], { encoding: 'utf8' });
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /PHOTO_BUILD_ARGUMENTS_INVALID/);
  }
});
