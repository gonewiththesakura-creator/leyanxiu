import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { candidateDependencies, candidateSourceFiles, inspectCandidatePlan,
  projectCandidateLock, validateCandidateImports } from '../scripts/plan-mini-photo-candidate.mjs';

const server = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));

test('read-only plan inventories reviewed sources and locked dependencies without claiming an artifact or deployment', () => {
  const result = spawnSync(process.execPath, ['scripts/plan-mini-photo-candidate.mjs'], { cwd: server, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.runnableArtifactCreated, false); assert.equal(plan.deployable, false);
  assert.equal(plan.generationEnabled, false); assert.equal(plan.processEnabled, false);
  assert.equal(plan.paymentEnv, 1); assert.equal(plan.sandboxMayCharge, true);
  assert.equal(plan.dependencyLock.packages, 116); assert.equal(plan.dependencyLock.installed, false);
  assert.equal(plan.dependencyLock.registryResolutionPerformed, false);
  assert.deepEqual(plan.directDependencies, candidateDependencies);
  assert.doesNotMatch(result.stdout, /https:|PRIVATE KEY|Bearer |password/);
  const detail = inspectCandidatePlan();
  assert.equal(detail.files.length + detail.missingSources.length, candidateSourceFiles.length);
  for (const file of detail.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0);
    assert.doesNotMatch(file.path, /(^|\/)(?:\.env|data|output|evidence|node_modules|android)(?:\/|$)|\.(?:png|jpg|db|sqlite)$/);
  }
  const invalid = spawnSync(process.execPath, ['scripts/plan-mini-photo-candidate.mjs', '--execute'], { cwd: server, encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /NO_ARGUMENTS_ALLOWED/);
});

test('projected lock keeps exact reviewed records and rejects new versions, missing paths or install hooks', () => {
  const projected = projectCandidateLock(lock);
  assert.equal(Object.keys(projected.packages).length, 117);
  for (const [key, value] of Object.entries(projected.packages)) if (key) assert.deepEqual(value, lock.packages[key]);
  assert.equal(projected.packages['node_modules/qs'].version, '6.16.0');
  assert.ok(projected.packages['node_modules/kitx/node_modules/@types/node']);
  assert.equal(projected.packages['node_modules/better-sqlite3'], undefined);
  assert.equal(projected.packages['node_modules/@alicloud/facebody20191230'], undefined);
  assert.equal(projected.packages['node_modules/dotenv'], undefined);
  for (const modify of [
    l => { l.packages['node_modules/ali-oss'].version = '99.0.0'; },
    l => { delete l.packages['node_modules/address']; },
    l => { l.packages['node_modules/ali-oss'].hasInstallScript = true; },
    l => { l.packages['node_modules/ali-oss'].resolved = 'https://private.invalid/package.tgz'; },
    l => { l.packages['node_modules/qs'].version = '6.5.0'; },
    l => { l.packages['node_modules/ali-oss'].integrity = ''; },
  ]) {
    const changed = structuredClone(lock); modify(changed);
    assert.throws(() => projectCandidateLock(changed), /PHOTO_PLAN_/);
  }
});

test('source import plan rejects legacy bootstrap, unlisted packages, computed imports and SQLite outside its existing lazy branch', () => {
  assert.deepEqual(validateCandidateImports('photo-jobs/candidate-server.js',
    "import { serve } from '@hono/node-server';\nimport { virtualRuntime } from '../payments/virtual/runtime.js';"), ['@hono/node-server']);
  assert.deepEqual(validateCandidateImports('payments/virtual/database.js', "await import('better-sqlite3');"), []);
  for (const source of ["import '../index.js';", "import '../.env';", "import 'dotenv/config';",
    "await import('better-sqlite3');", 'await import(variable);', "require('ali-oss');"]) {
    assert.throws(() => validateCandidateImports('photo-jobs/candidate-server.js', source), /PHOTO_PLAN_/);
  }
});
