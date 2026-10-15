import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startPhotoProductionServer } from './production-server.js';

const maximumBytes = 65536;
const documents = [
  { prefix: 'PHOTO_PRODUCTION_CONFIG', filename: 'config.json' },
  { prefix: 'PHOTO_PRODUCTION_ACCEPTANCE', filename: 'acceptance.json' },
  { prefix: 'XPAY_ACCEPTANCE', filename: 'xpay-acceptance.json' },
];
const fail = code => Object.assign(new Error(`PHOTO_PRODUCTION_BOOTSTRAP_${code}`), { code: `PHOTO_PRODUCTION_BOOTSTRAP_${code}` });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = stat => `${stat.dev}:${stat.ino}`;
const safeCode = error => /^(?:PHOTO_(?:PRODUCTION|CANDIDATE)|XPAY)_[A-Z0-9_]{1,100}$/.test(error?.code || '')
  ? error.code : 'PHOTO_PRODUCTION_BOOTSTRAP_START_UNCONFIRMED';

function inlineBytes(env, { prefix, filename }) {
  const encoded = env[`${prefix}_BASE64`];
  if (env[`${prefix}_JSON`] !== undefined) throw fail('BASE64_ONLY');
  if (encoded === undefined) return null;
  // Empty FILE is also an explicit conflicting selection. Do not silently
  // substitute inline bytes for a previously configured mounted file.
  if (env[`${prefix}_FILE`] !== undefined) throw fail('SOURCE_CONFLICT');
  if (typeof encoded !== 'string' || encoded.length < 4 || encoded.length > 4 * Math.ceil(maximumBytes / 3)
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('BASE64_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 2 || bytes.length > maximumBytes || bytes.toString('base64') !== encoded) throw fail('BASE64_INVALID');
  const digest = env[`${prefix}_SHA256`];
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || hash(bytes) !== digest) throw fail('DIGEST_MISMATCH');
  try {
    // JSON is only checked for framing here. Keep every original byte and let
    // the existing server validate policy and evidence; never mint a report.
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  } catch { throw fail('JSON_INVALID'); }
  return { prefix, filename, bytes };
}

function privateMode(filename, mode) {
  fs.chmodSync(filename, mode);
  const stat = fs.lstatSync(filename);
  // The deployable target is Linux. Windows synthetic tests cannot establish
  // POSIX mode/owner guarantees; real startup there is rejected below.
  if (process.platform !== 'win32' && ((stat.mode & 0o777) !== mode || stat.uid !== process.getuid())) throw fail('PRIVATE_MODE_REQUIRED');
  return stat;
}

/** Turn only explicitly supplied base64 documents into ephemeral files. No
 * environment file loading, SDK, SQL, network or worker startup. Caller-owned
 * FILE paths are left untouched and continue through the server's validator.
 */
export function materializePhotoProductionFiles({ env, temporaryRoot = os.tmpdir() } = {}) {
  if (!env || typeof env !== 'object') throw fail('ENV_REQUIRED');
  const supplied = documents.map(document => inlineBytes(env, document)).filter(Boolean);
  let directory, directoryIdentity, disposed = false;
  const files = [], paths = {};
  const clean = () => {
    if (disposed) return;
    if (!directory) { disposed = true; return; }
    try {
      if (!fs.existsSync(directory)) { disposed = true; return; }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== directoryIdentity
        || fs.realpathSync(directory) !== directory) throw fail('CLEANUP_UNCONFIRMED');
      for (const file of files) {
        let current;
        try { current = fs.lstatSync(file.path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!current.isFile() || current.isSymbolicLink() || identity(current) !== file.identity) throw fail('CLEANUP_UNCONFIRMED');
        fs.unlinkSync(file.path);
      }
      // Non-recursive: never remove injected/unrelated entries or a replaced
      // directory merely because they happen to occupy our former pathname.
      fs.rmdirSync(directory); disposed = true;
    } catch { throw fail('CLEANUP_UNCONFIRMED'); }
  };
  try {
    if (supplied.length) {
      if (typeof temporaryRoot !== 'string' || !path.isAbsolute(temporaryRoot)) throw fail('TEMP_ROOT_INVALID');
      const root = path.resolve(temporaryRoot), stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) throw fail('TEMP_ROOT_INVALID');
      directory = fs.mkdtempSync(path.join(root, 'leyanxiu-photo-production-'));
      directoryIdentity = identity(fs.lstatSync(directory));
      privateMode(directory, 0o700);
      for (const document of supplied) {
        const filename = path.join(directory, document.filename);
        const descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try {
          const stat = fs.fstatSync(descriptor);
          if (!stat.isFile() || stat.nlink !== 1) throw fail('REGULAR_FILE_REQUIRED');
          files.push({ path: filename, identity: identity(stat) });
          fs.writeFileSync(descriptor, document.bytes);
        } finally { fs.closeSync(descriptor); }
        const stat = privateMode(filename, 0o600);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename
          || stat.size !== document.bytes.length || hash(fs.readFileSync(filename)) !== hash(document.bytes)) throw fail('FILE_UNCONFIRMED');
        paths[`${document.prefix}_FILE`] = filename;
      }
    }
    return Object.freeze({ paths: Object.freeze(paths), cleanup: clean });
  } catch (error) {
    try { clean(); } catch { throw fail('CLEANUP_UNCONFIRMED'); }
    throw /^PHOTO_PRODUCTION_BOOTSTRAP_/.test(error?.code || '') ? error : fail('FILES_UNCONFIRMED');
  }
}

/** Runtime adapter only. Preserve the real process.env object required by the
 * canonical payment runtime. Shutdown drains the existing server before
 * removing files still needed by readiness inspections and pending workers.
 */
export async function startPhotoProductionBootstrap({ env = process.env, temporaryRoot,
  startServer = startPhotoProductionServer, signals = process, serverOptions = {} } = {}) {
  if (process.platform !== 'linux' && startServer === startPhotoProductionServer && !serverOptions.runtimeFactory) throw fail('LINUX_RUNTIME_REQUIRED');
  if (typeof startServer !== 'function' || !signals?.on || !signals?.removeListener) throw fail('PORT_REQUIRED');
  const prepared = materializePhotoProductionFiles({ env, temporaryRoot });
  const installed = [];
  let starting, running, stopping, finished = false;
  const logFailure = error => {
    if (signals === process) { console.error(safeCode(error)); process.exitCode = 1; }
  };
  const finish = () => {
    if (finished) return;
    prepared.cleanup();
    for (const key of installed) if (env[key] === prepared.paths[key]) delete env[key];
    for (const name of ['SIGTERM', 'SIGINT']) signals.removeListener(name, signalStop);
    signals.removeListener('exit', exitClean); finished = true;
  };
  const shutdown = () => {
    if (!stopping) stopping = (async () => {
      try {
        try { running = await starting; } catch { /* The server cleans its failed startup before rejecting. */ }
        return running ? await running.shutdown() : { stopped: true };
      } finally { finish(); }
    })();
    return stopping;
  };
  function signalStop() { shutdown().catch(logFailure); }
  function exitClean() { try { finish(); } catch (error) { logFailure(error); } }
  try {
    for (const [key, value] of Object.entries(prepared.paths)) { env[key] = value; installed.push(key); }
    for (const name of ['SIGTERM', 'SIGINT']) signals.on(name, signalStop);
    signals.on('exit', exitClean);
    starting = Promise.resolve().then(() => startServer({ ...serverOptions, env, signals }));
    running = await starting;
    if (!running || typeof running.shutdown !== 'function') throw fail('SERVER_CONTRACT_INVALID');
    return Object.freeze({ ...running, shutdown });
  } catch (error) {
    try { await shutdown(); } catch { throw fail('CLEANUP_UNCONFIRMED'); }
    const code = safeCode(error); throw Object.assign(new Error(code), { code });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('PHOTO_PRODUCTION_BOOTSTRAP_NO_ARGUMENTS_ALLOWED'); process.exitCode = 1; }
  else startPhotoProductionBootstrap().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
}
