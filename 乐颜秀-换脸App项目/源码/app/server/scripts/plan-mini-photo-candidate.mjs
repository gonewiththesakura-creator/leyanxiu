import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
export const candidateDependencies = Object.freeze({
  '@alicloud/openapi-client': '0.4.15', '@alicloud/tea-util': '1.4.9',
  '@hono/node-server': '1.19.17', 'ali-oss': '6.23.0', hono: '4.13.7', mysql2: '3.24.4',
});
export const candidateOverrides = Object.freeze({ qs: '6.16.0' });
export const candidatePendingSources = Object.freeze([
  'photo-jobs/candidate-host.js', 'photo-jobs/candidate-server.js', 'photo-jobs/generation-lifecycle.js', 'photo-jobs/generation-acceptance.js',
]);
const paymentNames = ['database', 'ledger', 'reservation-transactions', 'wechat', 'runtime', 'mysql-transport',
  'products', 'routes', 'reconciliation', 'message-endpoint', 'cloud-message-endpoint',
  'cloud-business-endpoint', 'mini-identity', 'mini-sandbox-service'];
const photoNames = ['application', 'candidate-public', 'context', 'repository', 'routes', 'worker', 'native-routes',
  'upload-repository', 'upload-storage', 'upload-service', 'upload-routes', 'upload-cleanup',
  'moderation', 'output-storage', 'media-ports', 'qwen-provider', 'image-marker', 'input-normalizer',
  'generation-repository', 'generation-pipeline', 'generation-cleanup'];
export const candidateSourceFiles = Object.freeze([
  ...candidatePendingSources, ...paymentNames.map(name => `payments/virtual/${name}.js`),
  ...photoNames.map(name => `photo-jobs/${name}.js`), 'media-validation.js', 'mark-ai.py', 'normalize-photo-input.py',
  'deploy/mini-payment/sandbox-schema-v1.sql', 'deploy/mini-payment/mini-identity-schema-v1.sql',
  'deploy/mini-payment/photo-jobs-schema-v1.sql', 'photo-jobs/context-schema.sql',
  'photo-jobs/upload-schema.sql', 'photo-jobs/generation-schema.sql',
]);

/** Local planning only: retain the existing v3 lock's resolved paths, versions,
 * integrity and metadata. Never resolve a registry range or install anything.
 * The projected lock is not npm-ci/container acceptance and is not written. */
export function projectCandidateLock(lock) {
  if (lock?.lockfileVersion !== 3 || !lock.packages?.['']) fail('PHOTO_PLAN_LOCK_V3_REQUIRED');
  const packages = lock.packages, selected = new Set();
  const packageName = value => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value);
  function resolve(name, from) {
    if (!packageName(name)) fail('PHOTO_PLAN_DEPENDENCY_NAME_INVALID');
    let directory = from;
    while (directory) {
      // Resolve exactly as an installed nested node_modules tree, not by name
      // alone; different SDK branches retain their own version when present.
      if (path.posix.basename(directory) !== 'node_modules') {
        const candidate = `${directory}/node_modules/${name}`;
        if (Object.hasOwn(packages, candidate)) return candidate;
      }
      directory = path.posix.dirname(directory);
      if (directory === '.') directory = '';
    }
    return Object.hasOwn(packages, `node_modules/${name}`) ? `node_modules/${name}` : null;
  }
  function visit(key) {
    if (selected.has(key)) return;
    const item = packages[key];
    // Unexpected native/postinstall/code sources require another review. No
    // credentials, local paths, Git sources, new ranges or registry URLs enter.
    if (!item || item.link || item.hasInstallScript || item.dev === true
      || typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(item.version)
      || typeof item.resolved !== 'string' || !item.resolved.startsWith('https://registry.npmjs.org/')
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity || '')) fail('PHOTO_PLAN_LOCK_ENTRY_UNREVIEWED');
    const address = new URL(item.resolved);
    if (address.hostname !== 'registry.npmjs.org' || address.username || address.password || address.port
      || address.search || address.hash) fail('PHOTO_PLAN_LOCK_ENTRY_UNREVIEWED');
    selected.add(key);
    const names = new Set([...Object.keys(item.dependencies || {}), ...Object.keys(item.optionalDependencies || {}),
      ...Object.keys(item.peerDependencies || {})]);
    for (const name of names) {
      const resolved = resolve(name, key);
      if (resolved) visit(resolved);
      else if (!Object.hasOwn(item.optionalDependencies || {}, name) && item.peerDependenciesMeta?.[name]?.optional !== true) {
        fail('PHOTO_PLAN_LOCK_DEPENDENCY_MISSING');
      }
    }
  }
  for (const [name, version] of Object.entries(candidateDependencies)) {
    const key = `node_modules/${name}`;
    if (packages[key]?.version !== version) fail('PHOTO_PLAN_DIRECT_VERSION_CHANGED');
    visit(key);
  }
  if (packages['node_modules/qs']?.version !== candidateOverrides.qs || !selected.has('node_modules/qs')) {
    fail('PHOTO_PLAN_SECURITY_OVERRIDE_CHANGED');
  }
  const name = 'leyanxiu-mini-photo-candidate';
  return { name, version: '0.1.0', lockfileVersion: 3, requires: true, packages: {
    '': { name, version: '0.1.0', dependencies: { ...candidateDependencies } },
    ...Object.fromEntries([...selected].sort().map(key => [key, structuredClone(packages[key])])),
  } };
}

// This deliberately checks only this repository's literal ESM import style; it
// is not a JavaScript sandbox or proof that arbitrary source cannot do IO.
export function validateCandidateImports(relative, source) {
  const literals = [...source.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"\r\n]+)['"]/g)].map(m => m[1]);
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g)].map(m => m[1]);
  if ([...source.matchAll(/\bimport\s*\(/g)].length !== dynamic.length || /\brequire\s*\(/.test(source)) {
    fail('PHOTO_PLAN_IMPORT_SYNTAX_UNREVIEWED');
  }
  const external = new Set();
  for (const specifier of [...literals, ...dynamic]) {
    if (specifier.startsWith('node:')) continue;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!candidateSourceFiles.includes(target)) fail('PHOTO_PLAN_SOURCE_DEPENDENCY_UNLISTED');
    } else if (relative === 'payments/virtual/database.js' && specifier === 'better-sqlite3' && dynamic.includes(specifier)) {
      // Existing lazy SQLite branch is excluded from the MySQL-only candidate.
      // Its unreachability still needs real host/config tests, not this scanner.
    } else {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!Object.hasOwn(candidateDependencies, name)) fail('PHOTO_PLAN_EXTERNAL_DEPENDENCY_UNLISTED');
      external.add(name);
    }
  }
  return [...external].sort();
}

export function inspectCandidatePlan({ root = server } = {}) {
  const manifest = [], missing = [], imported = new Set();
  const read = relative => {
    const target = path.join(root, relative);
    if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== path.resolve(target)) fail('PHOTO_PLAN_REGULAR_SOURCE_REQUIRED');
    return fs.readFileSync(target);
  };
  for (const relative of candidateSourceFiles) {
    if (!fs.existsSync(path.join(root, relative))) {
      if (!candidatePendingSources.includes(relative)) fail('PHOTO_PLAN_SOURCE_MISSING');
      missing.push(relative); continue;
    }
    const bytes = read(relative);
    if (relative.endsWith('.js')) for (const name of validateCandidateImports(relative, bytes.toString('utf8'))) imported.add(name);
    manifest.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  const lockBytes = read('package-lock.json');
  const projectedLock = projectCandidateLock(JSON.parse(lockBytes));
  return { version: 1, scope: 'mini-photo-candidate-plan-only', runnableArtifactCreated: false, deployable: false,
    mode: 'closed', paymentEnv: 1, productionPaymentsEnabled: false, sandboxMayCharge: true,
    generationEnabled: false, processEnabled: false, missingSources: missing, files: manifest,
    directDependencies: candidateDependencies, observedExternalImports: [...imported].sort(), overrides: candidateOverrides,
    dependencyLock: { sourceSha256: hash(lockBytes), projectedSha256: hash(JSON.stringify(projectedLock)),
      packages: Object.keys(projectedLock.packages).length - 1, registryResolutionPerformed: false, installed: false },
    excludedLazyDependency: 'better-sqlite3', includesPrivateConfig: false,
    blockers: [...(missing.length ? ['real candidate entry/assembly incomplete'] : []),
      'candidate entry and closed configuration require independent runtime acceptance',
      'projected lock has not passed clean Linux npm ci', 'Node image digest and OS/Pillow/font versions remain unpinned',
      'no candidate Docker/package/archive emitted by this read-only planner'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('PHOTO_PLAN_NO_ARGUMENTS_ALLOWED');
    const plan = inspectCandidatePlan();
    console.log(JSON.stringify({ ...plan, files: plan.files.length }, null, 2));
  } catch (error) {
    console.error(/^PHOTO_PLAN_[A-Z_]+$/.test(error?.message) ? error.message : 'PHOTO_PLAN_UNCONFIRMED');
    process.exitCode = 1;
  }
}
