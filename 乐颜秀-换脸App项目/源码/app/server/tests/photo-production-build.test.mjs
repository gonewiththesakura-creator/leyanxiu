import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPhotoProduction, verifyPhotoProductionBundle, productionSourceFiles, projectProductionLock } from '../scripts/build-mini-photo-production.mjs';
import { candidateDependencies, projectCandidateLock } from '../scripts/plan-mini-photo-candidate.mjs';

const server = fileURLToPath(new URL('../', import.meta.url));
const packaging = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'runtime-image.json', 'README.md'];
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (root, relative, bytes) => { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-production-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  for (const relative of [...productionSourceFiles, 'package-lock.json', ...packaging.map(name => 'deploy/mini-photo-production/' + name)]) {
    write(source, relative, fs.readFileSync(path.join(server, relative)));
  }
  const output = path.join(directory, 'bundle');
  return { source, output, directory, build: () => buildPhotoProduction({ root: source, output }) };
}

test('production package excludes private inputs and sandbox SQL, uses the existing lock, and declares closed env0', t => {
  const f = fixture(t);
  for (const relative of ['.env', '.env.mini-payment', '.env.production', 'data/account.sqlite', 'evidence/report.json',
    'output/user.png', 'node_modules/not-for-package.js', 'deploy/mini-payment/sandbox-schema-v1.sql']) {
    write(f.source, relative, 'SYNTHETIC_PRIVATE_CANARY_MUST_NOT_PACK');
  }
  const result = f.build(); const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'manifest.json')));
  assert.equal(productionSourceFiles.length, 50); assert.equal(result.files, 56);
  assert.equal(result.verified, true); assert.equal(result.deployable, false); assert.equal(result.deployed, false);
  assert.deepEqual(result.defaults, { env: 0, mode: 'closed', purchaseEnabled: false, generationEnabled: false,
    processEnabled: false, cleanupEnabled: false, reconcileEnabled: false, productionPaymentsEnabled: false });
  assert.equal(manifest.version, 2); assert.equal(manifest.entry, 'photo-jobs/production-bootstrap.js'); assert.equal(manifest.includesPrivateConfig, false);
  const files = manifest.files.map(file => file.path);
  assert.deepEqual(files.filter(name => name.endsWith('.sql')), ['deploy/mini-payment/production-binding-dmc-v2.sql', 'deploy/mini-payment/production-schema-v1.sql']);
  assert.equal(files.includes('index.js'), false); assert.equal(files.includes('payments/virtual/mini-sandbox-server.js'), false);
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(f.output, file.path));
    assert.equal(file.sha256, hash(bytes)); assert.equal(file.bytes, bytes.length);
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_CANARY_MUST_NOT_PACK')), false);
  }
  const sourceLock = JSON.parse(fs.readFileSync(path.join(server, 'package-lock.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(f.output, 'package-lock.json')));
  assert.deepEqual(lock, projectProductionLock(sourceLock));
  assert.deepEqual(Object.entries(lock.packages).filter(([key]) => key !== ''),
    Object.entries(projectCandidateLock(sourceLock).packages).filter(([key]) => key !== ''));
  const packageJson = JSON.parse(fs.readFileSync(path.join(f.output, 'package.json')));
  assert.deepEqual(packageJson.dependencies, candidateDependencies);
  assert.equal(packageJson.scripts.start, 'node photo-jobs/production-bootstrap.js');
  assert.equal(manifest.dependencyLock.packages, 116); assert.equal(manifest.dependencyLock.installed, false);
  assert.equal(manifest.runtime.imageBuilt, false); assert.equal(manifest.runtime.linuxNpmCiVerified, false);
  assert.equal(manifest.runtime.linuxMarkerVerified, false);
  const docker = fs.readFileSync(path.join(f.output, 'Dockerfile'), 'utf8');
  assert.match(docker, /XPAY_ENV=0 .*XPAY_MODE=closed/);
  assert.match(docker, /PHOTO_PRODUCTION_GENERATION_ENABLED=false PHOTO_PRODUCTION_PROCESS_ENABLED=false PHOTO_PRODUCTION_CLEANUP_ENABLED=false/);
  assert.match(docker, /XPAY_RECONCILE_ENABLED=false/); assert.match(docker, /^USER node$/m);
  assert.match(docker, /CMD \["node", "photo-jobs\/production-bootstrap.js"\]/);
  assert.match(docker, /materializePhotoProductionFiles/); assert.match(docker, /files\.cleanup\(\)/);
  assert.match(docker, /python3 normalize-photo-input\.py --check/);
  assert.ok(files.includes('normalize-photo-input.py')); assert.ok(files.includes('photo-jobs/input-normalizer.js'));
  assert.ok(files.includes('photo-jobs/generation-acceptance.js'));
  assert.deepEqual(verifyPhotoProductionBundle(f.output), result);
});

test('exclusive creation preserves existing output and missing formal dependencies leave no output', t => {
  const f = fixture(t); fs.mkdirSync(f.output); write(f.output, 'original.txt', 'preserve');
  assert.throws(f.build, /NEW_ABSOLUTE_DIRECTORY_REQUIRED/); assert.equal(fs.readFileSync(path.join(f.output, 'original.txt'), 'utf8'), 'preserve');
  const newOutput = path.join(f.directory, 'other');
  for (const relative of ['photo-jobs/production-bootstrap.js', 'photo-jobs/production-server.js', 'payments/virtual/mini-service.js', 'deploy/mini-payment/production-schema-v1.sql']) {
    const file = path.join(f.source, relative), bytes = fs.readFileSync(file); fs.unlinkSync(file);
    assert.throws(() => buildPhotoProduction({ root: f.source, output: newOutput }), /REGULAR_FILE_REQUIRED/);
    assert.equal(fs.existsSync(newOutput), false); fs.writeFileSync(file, bytes);
  }
});

test('unlisted, private or computed imports cannot expand the formal closure', t => {
  const f = fixture(t);
  for (const source of ["import '../index.js';", "import 'dotenv/config';", "await import('../private.js');",
    'await import(process.env.ENTRY);', "require('ali-oss');", "export {secret} from '../.env';"]) {
    write(f.source, 'photo-jobs/production-server.js', source);
    assert.throws(f.build, /PHOTO_PRODUCTION_BUILD_(?:IMPORT_SYNTAX_UNREVIEWED|SOURCE_DEPENDENCY_UNLISTED|EXTERNAL_DEPENDENCY_UNLISTED)/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('linked source and changed lock hooks are rejected before output creation', t => {
  const f = fixture(t); const original = path.join(f.source, 'photo-jobs'), elsewhere = path.join(f.directory, 'elsewhere');
  fs.renameSync(original, elsewhere); fs.symlinkSync(elsewhere, original, 'junction');
  assert.throws(f.build, /REGULAR_FILE_REQUIRED/); fs.unlinkSync(original); fs.renameSync(elsewhere, original);
  const file = path.join(f.source, 'package-lock.json'), lock = JSON.parse(fs.readFileSync(file));
  lock.packages['node_modules/ali-oss'].hasInstallScript = true;
  fs.writeFileSync(file, JSON.stringify(lock)); assert.throws(f.build, /PHOTO_PLAN_LOCK_ENTRY_UNREVIEWED/);
  assert.equal(fs.existsSync(f.output), false);
});

test('appended Docker overrides, broad COPY, package scripts and an altered schema require explicit review', t => {
  const f = fixture(t); const dockerFile = path.join(f.source, 'deploy/mini-photo-production/Dockerfile');
  const docker = fs.readFileSync(dockerFile);
  for (const text of ['\nENV XPAY_MODE=live\n', '\nENV PHOTO_PRODUCTION_PROCESS_ENABLED=true\n', '\nUSER root\n',
    '\nCOPY . .\n', '\nENV DEBUG=*\n', '\nCMD ["node", "photo-jobs/candidate-server.js"]\n']) {
    fs.writeFileSync(dockerFile, Buffer.concat([docker, Buffer.from(text)])); assert.throws(f.build, /DOCKER_UNREVIEWED/);
  }
  fs.writeFileSync(dockerFile, docker);
  const schema = path.join(f.source, 'deploy/mini-payment/production-schema-v1.sql'); fs.appendFileSync(schema, '\nSELECT 1;\n');
  assert.throws(f.build, /SCHEMA_UNREVIEWED/);
  const packageFile = path.join(f.source, 'deploy/mini-photo-production/package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageFile)); packageJson.scripts.postinstall = 'node index.js';
  fs.writeFileSync(packageFile, JSON.stringify(packageJson)); assert.throws(f.build, /PACKAGE_CHANGED/);
  assert.equal(fs.existsSync(f.output), false);
});

test('verification rejects private extras, modified bytes and false claims, including rehashed policy changes', t => {
  const f = fixture(t); f.build();
  const manifestFile = path.join(f.output, 'manifest.json'), baseline = fs.readFileSync(manifestFile);
  write(f.output, '.env', 'synthetic'); assert.throws(() => verifyPhotoProductionBundle(f.output), /FILE_SET_CHANGED/); fs.unlinkSync(path.join(f.output, '.env'));
  const sourceFile = path.join(f.output, 'photo-jobs/production-host.js'), bytes = fs.readFileSync(sourceFile);
  fs.appendFileSync(sourceFile, '\n// change\n'); assert.throws(() => verifyPhotoProductionBundle(f.output), /FILE_HASH_MISMATCH/); fs.writeFileSync(sourceFile, bytes);
  for (const change of [m => {m.version = 1;}, m => {m.defaults.env = 1;}, m => {m.defaults.purchaseEnabled = true;}, m => {m.runtime.imageBuilt = true;}, m => {m.runtime.nodeVersion = '99.0.0';},
    m => {m.entry = 'photo-jobs/candidate-server.js';}, m => {m.dependencyLock.installed = true;}, m => {m.files[0].path = '../private';}]) {
    const manifest = JSON.parse(baseline); change(manifest); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => verifyPhotoProductionBundle(f.output), /MANIFEST_INVALID/);
  }
  const manifest = JSON.parse(baseline); const dockerFile = path.join(f.output, 'Dockerfile');
  fs.appendFileSync(dockerFile, '\nENV XPAY_MODE=live\n');
  const altered = fs.readFileSync(dockerFile), record = manifest.files.find(file => file.path === 'Dockerfile');
  record.sha256 = hash(altered); record.bytes = altered.length; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => verifyPhotoProductionBundle(f.output), /DOCKER_UNREVIEWED/);
});

test('no-argument CLI is inert and execution, installation or deployment flags are refused', t => {
  const script = fileURLToPath(new URL('../scripts/build-mini-photo-production.mjs', import.meta.url));
  const idle = spawnSync(process.execPath, [script], {encoding:'utf8'});
  assert.equal(idle.status, 0, idle.stderr); assert.deepEqual(JSON.parse(idle.stdout), {action:'NO_OP',deployed:false,installed:false});
  const f = fixture(t); f.build();
  const verified = spawnSync(process.execPath, [script, '--verify', f.output], {encoding:'utf8'});
  assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).verified, true);
  for (const flag of ['--deploy','--execute','--install']) {
    const result = spawnSync(process.execPath,[script,flag,f.output],{encoding:'utf8'});
    assert.equal(result.status,1); assert.match(result.stderr,/ARGUMENTS_INVALID/);
  }
});
