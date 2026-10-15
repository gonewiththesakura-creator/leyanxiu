import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { candidateDependencies, candidateOverrides, projectCandidateLock } from './plan-mini-photo-candidate.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const scope = 'mini-photo-production-local';
const packageName = 'leyanxiu-mini-photo-production';
const entry = 'photo-jobs/production-bootstrap.js';
const digest = 'sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562';
const dockerPolicySha256 = '6e435819dbcafb56ef2707b2a16a69e77b26ce6a2edf0e3e87fe1e8b5385dbc9';
const schemaSha256 = '6a8c2b685d9931017411fb438733e9ec01232347114de39ef673d943f9ef973e';
const schemaPath = 'deploy/mini-payment/production-schema-v1.sql';
const dmcBindingPath = 'deploy/mini-payment/production-binding-dmc-v2.sql';
const dmcBindingSha256 = '343235708607bf342a954b7055f0b9ef233edc0b5028c65c2a706bd4a6240d91';
const packageFiles = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'runtime-image.json', 'README.md'];
// This is an independent exact list. Future candidate-list changes cannot
// silently broaden the formal package or add old sandbox initialization SQL.
const paymentNames = ['database', 'ledger', 'reservation-transactions', 'wechat', 'runtime', 'mysql-transport',
  'products', 'routes', 'reconciliation', 'message-endpoint', 'cloud-message-endpoint', 'cloud-business-endpoint',
  'mini-identity', 'mini-sandbox-service', 'mini-service', 'mini-production-service', 'mini-refund-operator'];
const photoNames = ['application', 'candidate-host', 'candidate-server', 'candidate-public', 'context', 'repository',
  'routes', 'worker', 'native-routes', 'upload-repository', 'upload-storage', 'upload-service', 'upload-routes',
  'upload-cleanup', 'moderation', 'output-storage', 'media-ports', 'qwen-provider', 'image-marker', 'input-normalizer',
  'generation-repository', 'generation-pipeline', 'generation-cleanup', 'generation-lifecycle', 'generation-acceptance', 'production-host', 'production-server', 'production-bootstrap'];
export const productionSourceFiles = Object.freeze([
  ...paymentNames.map(name => `payments/virtual/${name}.js`), ...photoNames.map(name => `photo-jobs/${name}.js`),
  'media-validation.js', 'mark-ai.py', 'normalize-photo-input.py', schemaPath, dmcBindingPath,
]);
const expectedPaths = [...productionSourceFiles, ...packageFiles].sort();
const defaults = Object.freeze({ env: 0, mode: 'closed', purchaseEnabled: false, generationEnabled: false,
  processEnabled: false, cleanupEnabled: false, reconcileEnabled: false, productionPaymentsEnabled: false });

export function projectProductionLock(lock) {
  const result = projectCandidateLock(lock);
  result.name = packageName; result.packages[''].name = packageName;
  return result;
}

function regular(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(target)
    || !fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target) fail('PHOTO_PRODUCTION_BUILD_REGULAR_FILE_REQUIRED');
  return fs.readFileSync(target);
}

// Same literal ESM policy as the candidate planner, with a separate closed
// source list. This is a dependency closure check, not an arbitrary JS sandbox.
export function validateProductionImports(relative, source) {
  const literals = [...source.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"\r\n]+)['"]/g)].map(m => m[1]);
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g)].map(m => m[1]);
  if ([...source.matchAll(/\bimport\s*\(/g)].length !== dynamic.length || /\brequire\s*\(/.test(source)) {
    fail('PHOTO_PRODUCTION_BUILD_IMPORT_SYNTAX_UNREVIEWED');
  }
  for (const specifier of [...literals, ...dynamic]) {
    if (specifier.startsWith('node:')) continue;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (!productionSourceFiles.includes(target)) fail('PHOTO_PRODUCTION_BUILD_SOURCE_DEPENDENCY_UNLISTED');
    } else if (relative === 'payments/virtual/database.js' && specifier === 'better-sqlite3' && dynamic.includes(specifier)) {
      // The existing lazy SQLite branch is not installed. The formal entry
      // requires MySQL; its runtime tests establish that configuration boundary.
    } else {
      const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!Object.hasOwn(candidateDependencies, name)) fail('PHOTO_PRODUCTION_BUILD_EXTERNAL_DEPENDENCY_UNLISTED');
    }
  }
}

function validatePackaging(inputs) {
  const content = name => inputs.find(item => item.path === name)?.bytes;
  const packageJson = JSON.parse(content('package.json'));
  if (!isDeepStrictEqual(packageJson, { name: packageName, version: '0.1.0', private: true, type: 'module',
    scripts: { start: `node ${entry}` }, dependencies: candidateDependencies, overrides: candidateOverrides })) fail('PHOTO_PRODUCTION_BUILD_PACKAGE_CHANGED');
  const lock = JSON.parse(content('package-lock.json'));
  if (!isDeepStrictEqual(lock, projectProductionLock(lock))) fail('PHOTO_PRODUCTION_BUILD_LOCK_PROJECTION_CHANGED');
  const image = JSON.parse(content('runtime-image.json'));
  if (image.version !== 1 || image.registry !== 'https://registry-1.docker.io' || image.repository !== 'library/node'
    || image.platform !== 'linux/amd64' || image.nodeVersion !== '22.23.3' || image.manifestDigest !== digest
    || image.imageBuilt !== false) fail('PHOTO_PRODUCTION_BUILD_RUNTIME_UNREVIEWED');
  const docker = content('Dockerfile').toString('utf8');
  if (hash(docker.replace(/\r\n/g, '\n')) !== dockerPolicySha256) fail('PHOTO_PRODUCTION_BUILD_DOCKER_UNREVIEWED');
  const ignore = content('.dockerignore').toString('utf8').trim().split(/\r?\n/);
  if (!isDeepStrictEqual(ignore, ['**', '!Dockerfile', '!package.json', '!package-lock.json', '!runtime-image.json', '!manifest.json',
    '!media-validation.js', '!mark-ai.py', '!normalize-photo-input.py', '!photo-jobs', '!photo-jobs/*.js', '!payments', '!payments/virtual', '!payments/virtual/*.js'])) {
    fail('PHOTO_PRODUCTION_BUILD_CONTEXT_ALLOWLIST_CHANGED');
  }
  if (hash(content(schemaPath)) !== schemaSha256) fail('PHOTO_PRODUCTION_BUILD_SCHEMA_UNREVIEWED');
  if (hash(content(dmcBindingPath)) !== dmcBindingSha256) fail('PHOTO_PRODUCTION_BUILD_DMC_BINDING_UNREVIEWED');
}

function inspectInputs(root) {
  const inputs = productionSourceFiles.map(relative => ({ path: relative, bytes: regular(root, relative) }));
  for (const name of packageFiles) inputs.push({ path: name, bytes: regular(root, `deploy/mini-photo-production/${name}`) });
  for (const input of inputs) if (input.path.endsWith('.js')) validateProductionImports(input.path, input.bytes.toString('utf8'));
  validatePackaging(inputs);
  const sourceLock = regular(root, 'package-lock.json');
  const projected = projectProductionLock(JSON.parse(sourceLock));
  if (!isDeepStrictEqual(JSON.parse(inputs.find(item => item.path === 'package-lock.json').bytes), projected)) fail('PHOTO_PRODUCTION_BUILD_SOURCE_LOCK_DRIFT');
  return { inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)), sourceLockSha256: hash(sourceLock),
    projectedSha256: hash(JSON.stringify(projected)), lockPackages: Object.keys(projected.packages).length - 1 };
}

function inventory(directory, relative = '') {
  const output = [];
  for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    const target = path.join(directory, name);
    if (fs.realpathSync(target) !== path.resolve(target) || item.isSymbolicLink()) fail('PHOTO_PRODUCTION_BUILD_REGULAR_FILE_REQUIRED');
    if (item.isDirectory()) output.push(...inventory(directory, name));
    else if (item.isFile()) output.push(name);
    else fail('PHOTO_PRODUCTION_BUILD_REGULAR_FILE_REQUIRED');
  }
  return output.sort();
}

/** This integrity report is neither a signature nor deployment authorization.
 * Compare its manifest digest to the independently saved reviewed digest. */
export function verifyPhotoProductionBundle(output) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || !fs.existsSync(output)
    || !fs.lstatSync(output).isDirectory() || fs.realpathSync(output) !== path.resolve(output)) fail('PHOTO_PRODUCTION_BUILD_DIRECTORY_INVALID');
  if (!isDeepStrictEqual(inventory(output), [...expectedPaths, 'manifest.json'].sort())) fail('PHOTO_PRODUCTION_BUILD_FILE_SET_CHANGED');
  const bytes = regular(output, 'manifest.json');
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 2 || manifest.scope !== scope || manifest.entry !== entry || manifest.deployable !== false
    || manifest.includesPrivateConfig !== false || !isDeepStrictEqual(manifest.defaults, defaults)
    || !Array.isArray(manifest.files) || !isDeepStrictEqual(manifest.files.map(item => item.path).sort(), expectedPaths)
    || manifest.runtime?.imageDigest !== digest || manifest.runtime?.platform !== 'linux/amd64' || manifest.runtime?.nodeVersion !== '22.23.3'
    || manifest.runtime?.imageBuilt !== false || manifest.runtime?.linuxNpmCiVerified !== false || manifest.runtime?.linuxMarkerVerified !== false
    || !/^[a-f0-9]{64}$/.test(manifest.dependencyLock?.sourceSha256 || '')) fail('PHOTO_PRODUCTION_BUILD_MANIFEST_INVALID');
  const inputs = manifest.files.map(item => {
    const bytes = regular(output, item.path);
    if (!Number.isSafeInteger(item.bytes) || item.bytes !== bytes.length || item.sha256 !== hash(bytes)) fail('PHOTO_PRODUCTION_BUILD_FILE_HASH_MISMATCH');
    if (item.path.endsWith('.js')) validateProductionImports(item.path, bytes.toString('utf8'));
    return { path: item.path, bytes };
  });
  validatePackaging(inputs);
  const projected = projectProductionLock(JSON.parse(inputs.find(item => item.path === 'package-lock.json').bytes));
  if (manifest.dependencyLock.projectedSha256 !== hash(JSON.stringify(projected))
    || manifest.dependencyLock.packages !== Object.keys(projected.packages).length - 1
    || manifest.dependencyLock.registryResolutionPerformed !== false || manifest.dependencyLock.installed !== false) fail('PHOTO_PRODUCTION_BUILD_MANIFEST_INVALID');
  return { output: path.resolve(output), manifestSha256: hash(bytes), scope, files: inputs.length,
    verified: true, deployable: false, deployed: false, includesPrivateConfig: false, defaults: { ...defaults } };
}

export function buildPhotoProduction({ output, root = server } = {}) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || fs.existsSync(output)) fail('PHOTO_PRODUCTION_BUILD_NEW_ABSOLUTE_DIRECTORY_REQUIRED');
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== path.resolve(parent)) fail('PHOTO_PRODUCTION_BUILD_OUTPUT_PARENT_INVALID');
  const { inputs, sourceLockSha256, projectedSha256, lockPackages } = inspectInputs(root);
  // Exclusive creation never merges into another package. A failed partial
  // output remains available for inspection; it is not retried or overwritten.
  fs.mkdirSync(output);
  const files = [];
  for (const input of inputs) {
    const destination = path.join(output, input.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, input.bytes, { flag: 'wx' });
    files.push({ path: input.path, bytes: input.bytes.length, sha256: hash(input.bytes) });
  }
  const manifest = { version: 2, scope, entry, deployable: false, includesPrivateConfig: false, defaults: { ...defaults },
    runtime: { platform: 'linux/amd64', nodeVersion: '22.23.3', imageDigest: digest, imageBuilt: false,
      linuxNpmCiVerified: false, linuxMarkerVerified: false, osPackageVersions: 'recorded during actual Docker build' },
    dependencyLock: { sourceSha256: sourceLockSha256, projectedSha256, packages: lockPackages,
      registryResolutionPerformed: false, installed: false }, files,
    blockers: ['Linux image build and runtime acceptance not performed', 'private runtime configuration and new production database not applied by this builder',
      'existing-user refund operator allowlist and actual operational readiness must be configured and verified',
      'real native user delivery, payment and refund acceptance are separate from local packaging'] };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return verifyPhotoProductionBundle(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = args.length === 0 ? { action: 'NO_OP', deployed: false, installed: false }
      : args.length === 2 && args[0] === '--verify' ? verifyPhotoProductionBundle(args[1])
      : args.length === 1 && !args[0].startsWith('--') ? buildPhotoProduction({ output: args[0] }) : fail('PHOTO_PRODUCTION_BUILD_ARGUMENTS_INVALID');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^PHOTO_(?:PRODUCTION_BUILD|PLAN)_[A-Z_]+$/.test(error?.message) ? error.message : 'PHOTO_PRODUCTION_BUILD_UNCONFIRMED');
    process.exitCode = 1;
  }
}
