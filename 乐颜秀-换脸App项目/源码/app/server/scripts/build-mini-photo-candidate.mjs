import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { candidateDependencies, candidateOverrides, candidateSourceFiles,
  projectCandidateLock, validateCandidateImports } from './plan-mini-photo-candidate.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const scope = 'mini-photo-candidate-local';
const entry = 'photo-jobs/candidate-server.js';
const digest = 'sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562';
// Packaging policy changes require an explicit builder review, including an
// appended ENV/USER/RUN that would otherwise preserve the required substrings.
const dockerPolicySha256 = '05a18d5b9712a83bebd41917c7c34a47b4702edb988d6b3441f825aada05c484';
const packageFiles = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'runtime-image.json', 'README.md'];
const expectedPaths = [...candidateSourceFiles, ...packageFiles].sort();
const defaults = Object.freeze({ env: 1, mode: 'closed', purchaseEnabled: false, generationEnabled: false,
  processEnabled: false, cleanupEnabled: false, reconcileEnabled: false, productionPaymentsEnabled: false, sandboxMayCharge: true });

function regular(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(target)
    || !fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target) fail('PHOTO_BUILD_REGULAR_FILE_REQUIRED');
  return fs.readFileSync(target);
}

function validatePackaging(inputs) {
  const content = name => inputs.find(item => item.path === name)?.bytes;
  const manifest = JSON.parse(content('package.json'));
  if (!isDeepStrictEqual(manifest, { name: 'leyanxiu-mini-photo-candidate', version: '0.1.0', private: true, type: 'module',
    scripts: { start: `node ${entry}` }, dependencies: candidateDependencies, overrides: candidateOverrides })) fail('PHOTO_BUILD_PACKAGE_CHANGED');
  const lock = JSON.parse(content('package-lock.json'));
  if (!isDeepStrictEqual(lock, projectCandidateLock(lock))) fail('PHOTO_BUILD_LOCK_PROJECTION_CHANGED');
  const image = JSON.parse(content('runtime-image.json'));
  if (image.version !== 1 || image.registry !== 'https://registry-1.docker.io' || image.repository !== 'library/node'
    || image.platform !== 'linux/amd64' || image.nodeVersion !== '22.23.3' || image.manifestDigest !== digest
    || image.imageBuilt !== false) fail('PHOTO_BUILD_RUNTIME_UNREVIEWED');
  const docker = content('Dockerfile').toString('utf8');
  if (hash(docker.replace(/\r\n/g, '\n')) !== dockerPolicySha256
    || !docker.includes(`FROM node:22-bookworm-slim@${digest}`) || !/^USER node\r?$/m.test(docker)
    || !docker.includes('npm ci --omit=dev --ignore-scripts --no-audit --no-fund')
    || !docker.includes('python3 mark-ai.py --check-font') || !docker.includes('python3 normalize-photo-input.py --check') || !docker.includes(`CMD ["node", "${entry}"]`)
    || !docker.includes('NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt')
    || !docker.includes('PYTHON_PATH=/usr/bin/python3') || !docker.includes('AI_MARK_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    || !docker.includes('ca-certificates python3 python3-pil fonts-noto-cjk')
    || /COPY\s+(?:--[^\s]+\s+)*\.\s/i.test(docker)) fail('PHOTO_BUILD_DOCKER_UNREVIEWED');
  for (const setting of ['XPAY_MODE=closed', 'XPAY_ENABLED=true', 'XPAY_ENV=1', 'XPAY_DB_BACKEND=mysql',
    'DEBUG=""', 'NODE_DEBUG=""', 'NODE_DEBUG_NATIVE=""',
    'RELEASE_CHANNEL=wechat-mini-program', 'AUTH_MODE=wechat', 'XPAY_RECONCILE_ENABLED=false',
    'PHOTO_CANDIDATE_GENERATION_ENABLED=false', 'PHOTO_CANDIDATE_PROCESS_ENABLED=false', 'PHOTO_CANDIDATE_CLEANUP_ENABLED=false']) {
    if (!docker.includes(setting)) fail('PHOTO_BUILD_DEFAULT_GATE_CHANGED');
  }
  const ignore = content('.dockerignore').toString('utf8').trim().split(/\r?\n/);
  if (!isDeepStrictEqual(ignore, ['**', '!Dockerfile', '!package.json', '!package-lock.json', '!runtime-image.json', '!manifest.json',
    '!media-validation.js', '!mark-ai.py', '!normalize-photo-input.py', '!photo-jobs', '!photo-jobs/*.js', '!payments', '!payments/virtual', '!payments/virtual/*.js'])) {
    fail('PHOTO_BUILD_CONTEXT_ALLOWLIST_CHANGED');
  }
}

function inspectInputs(root) {
  // Snapshot every listed input before creating output. No glob copying, env,
  // data, evidence, user media, credentials, node_modules or old entry points.
  const inputs = candidateSourceFiles.map(relative => ({ path: relative, bytes: regular(root, relative) }));
  for (const name of packageFiles) inputs.push({ path: name, bytes: regular(root, `deploy/mini-photo-candidate/${name}`) });
  for (const input of inputs) if (input.path.endsWith('.js')) validateCandidateImports(input.path, input.bytes.toString('utf8'));
  validatePackaging(inputs);
  const sourceLock = regular(root, 'package-lock.json');
  const projected = projectCandidateLock(JSON.parse(sourceLock));
  const candidateLock = inputs.find(item => item.path === 'package-lock.json').bytes;
  if (!isDeepStrictEqual(JSON.parse(candidateLock), projected)) fail('PHOTO_BUILD_SOURCE_LOCK_DRIFT');
  return { inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)), sourceLockSha256: hash(sourceLock),
    projectedSha256: hash(JSON.stringify(projected)), lockPackages: Object.keys(projected.packages).length - 1 };
}

function inventory(directory, relative = '') {
  const output = [];
  for (const item of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    const target = path.join(directory, name);
    if (fs.realpathSync(target) !== path.resolve(target) || item.isSymbolicLink()) fail('PHOTO_BUILD_REGULAR_FILE_REQUIRED');
    if (item.isDirectory()) output.push(...inventory(directory, name));
    else if (item.isFile()) output.push(name);
    else fail('PHOTO_BUILD_REGULAR_FILE_REQUIRED');
  }
  return output.sort();
}

/** Integrity verification is not a signature or permission to deploy. The
 * returned manifest digest must be compared to the independently reviewed one.
 */
export function verifyPhotoCandidateBundle(output) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || !fs.existsSync(output)
    || !fs.lstatSync(output).isDirectory() || fs.realpathSync(output) !== path.resolve(output)) fail('PHOTO_BUILD_DIRECTORY_INVALID');
  if (!isDeepStrictEqual(inventory(output), [...expectedPaths, 'manifest.json'].sort())) fail('PHOTO_BUILD_FILE_SET_CHANGED');
  const bytes = regular(output, 'manifest.json');
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.scope !== scope || manifest.entry !== entry || manifest.deployable !== false
    || manifest.includesPrivateConfig !== false || !isDeepStrictEqual(manifest.defaults, defaults)
    || !Array.isArray(manifest.files) || !isDeepStrictEqual(manifest.files.map(item => item.path).sort(), expectedPaths)
    || manifest.runtime?.imageDigest !== digest || manifest.runtime?.platform !== 'linux/amd64'
    || manifest.runtime?.imageBuilt !== false || manifest.runtime?.linuxNpmCiVerified !== false
    || manifest.runtime?.linuxMarkerVerified !== false || !/^[a-f0-9]{64}$/.test(manifest.dependencyLock?.sourceSha256 || '')) {
    fail('PHOTO_BUILD_MANIFEST_INVALID');
  }
  const inputs = manifest.files.map(item => {
    const bytes = regular(output, item.path);
    if (!Number.isSafeInteger(item.bytes) || item.bytes !== bytes.length || item.sha256 !== hash(bytes)) fail('PHOTO_BUILD_FILE_HASH_MISMATCH');
    if (item.path.endsWith('.js')) validateCandidateImports(item.path, bytes.toString('utf8'));
    return { path: item.path, bytes };
  });
  validatePackaging(inputs);
  const projected = projectCandidateLock(JSON.parse(inputs.find(item => item.path === 'package-lock.json').bytes));
  if (manifest.dependencyLock.projectedSha256 !== hash(JSON.stringify(projected))
    || manifest.dependencyLock.packages !== Object.keys(projected.packages).length - 1
    || manifest.dependencyLock.registryResolutionPerformed !== false || manifest.dependencyLock.installed !== false) fail('PHOTO_BUILD_MANIFEST_INVALID');
  return { output: path.resolve(output), manifestSha256: hash(bytes), scope, files: inputs.length,
    verified: true, deployable: false, deployed: false, includesPrivateConfig: false, defaults: { ...defaults } };
}

export function buildPhotoCandidate({ output, root = server } = {}) {
  if (typeof output !== 'string' || !path.isAbsolute(output) || fs.existsSync(output)) fail('PHOTO_BUILD_NEW_ABSOLUTE_DIRECTORY_REQUIRED');
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.lstatSync(parent).isDirectory() || fs.realpathSync(parent) !== path.resolve(parent)) fail('PHOTO_BUILD_OUTPUT_PARENT_INVALID');
  const { inputs, sourceLockSha256, projectedSha256, lockPackages } = inspectInputs(root);
  // mkdir without recursive or overwrite is the exclusive claim. A race cannot
  // merge this bundle with an existing directory. Failed writes are preserved.
  fs.mkdirSync(output);
  const files = [];
  for (const input of inputs) {
    const destination = path.join(output, input.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, input.bytes, { flag: 'wx' });
    files.push({ path: input.path, bytes: input.bytes.length, sha256: hash(input.bytes) });
  }
  const manifest = { version: 1, scope, entry, deployable: false, includesPrivateConfig: false, defaults: { ...defaults },
    runtime: { platform: 'linux/amd64', nodeVersion: '22.23.3', imageDigest: digest, imageBuilt: false,
      linuxNpmCiVerified: false, linuxMarkerVerified: false, osPackageVersions: 'recorded during actual Docker build' },
    dependencyLock: { sourceSha256: sourceLockSha256, projectedSha256, packages: lockPackages,
      registryResolutionPerformed: false, installed: false }, files,
    blockers: ['Linux image build and runtime acceptance not performed', 'actual private configuration and same-database incremental migration not applied',
      'real provider delivery and native user acceptance remain separate', 'public service disclosures and reliable complaint receipt not assembled'] };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return verifyPhotoCandidateBundle(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = args.length === 2 && args[0] === '--verify' ? verifyPhotoCandidateBundle(args[1])
      : args.length === 1 && !args[0].startsWith('--') ? buildPhotoCandidate({ output: args[0] }) : fail('PHOTO_BUILD_ARGUMENTS_INVALID');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^PHOTO_(?:BUILD|PLAN)_[A-Z_]+$/.test(error?.message) ? error.message : 'PHOTO_BUILD_UNCONFIRMED');
    process.exitCode = 1;
  }
}
