import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const ACCOUNT_SECURITY_EVENTS = Object.freeze([
  'device.challenge', 'device.verify', 'phone.challenge', 'phone.verify',
  'account.logout', 'account.deleted', 'request.denied', 'request.rate_limited', 'retention.sweep',
]);
export const ACCOUNT_SECURITY_RESULTS = Object.freeze(['attempt', 'success', 'denied', 'failed', 'rate_limited', 'dry_run']);
export const ACCOUNT_SECURITY_REASONS = Object.freeze([
  'none', 'invalid_request', 'invalid_credentials', 'expired', 'replayed', 'unavailable',
  'persistence_failed', 'invite_required', 'account_only', 'rate_limit', 'consent_required',
  'account_unavailable', 'cleanup_failed', 'storage_failed',
]);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ACCOUNT_ID = new RegExp(`^usr_${UUID}$`, 'i');
const REQUEST_ID = new RegExp(`^req_${UUID}$`, 'i');
const SEGMENT = /^account-security-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const safeFailure = code => Object.assign(new Error(code), { securityLogCode: code });
const check = (condition, code) => { if (!condition) throw safeFailure(code); };
export const createSecurityRequestId = () => `req_${randomUUID()}`;

// UTC calendar arithmetic, clamped at month end (not six * thirty days).
export function accountSecurityRetentionCutoff(value) {
  const date = new Date(value);
  check(Number.isFinite(date.getTime()), 'LOG_CLOCK_INVALID');
  const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 6, 1));
  const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
  month.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  // Only full UTC days older than this boundary can be removed. The boundary day
  // stays intact, so every event is retained for at least six calendar months.
  return month;
}

function makeEvent(input, time) {
  check(input && typeof input === 'object' && !Array.isArray(input), 'LOG_INVALID_EVENT');
  // Access only own data properties; never evaluate an input getter or stringify input.
  const own = key => Object.getOwnPropertyDescriptor(input, key)?.value;
  const event = own('event');
  const result = own('result');
  const reason = own('reason') ?? 'none';
  check(ACCOUNT_SECURITY_EVENTS.includes(event) && ACCOUNT_SECURITY_RESULTS.includes(result)
    && ACCOUNT_SECURITY_REASONS.includes(reason), 'LOG_INVALID_EVENT');
  const entry = { version: 1, time, event, result, reason };
  for (const key of ['accountId', 'deviceId', 'requestId']) {
    const value = own(key);
    if (value === undefined || value === null) continue;
    check(typeof value === 'string' && (key === 'requestId' ? REQUEST_ID : ACCOUNT_ID).test(value), 'LOG_INVALID_EVENT');
    entry[key] = value;
  }
  const statusCode = own('statusCode');
  if (statusCode !== undefined) {
    check(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599, 'LOG_INVALID_EVENT');
    entry.statusCode = statusCode;
  }
  return entry;
}

function privateStat(stat, directory, uid, links = 1) {
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'LOG_UNSAFE_STORAGE');
  check((stat.mode & 0o7777) === (directory ? 0o700 : 0o600), 'LOG_UNSAFE_STORAGE');
  if (!directory) check(stat.nlink === links, 'LOG_UNSAFE_STORAGE');
  if (uid !== undefined) check(stat.uid === uid, 'LOG_UNSAFE_STORAGE');
}

const BOOT_ID = new RegExp(`^${UUID}$`, 'i');
function validIdentity(value) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
    && typeof value.bootId === 'string' && BOOT_ID.test(value.bootId)
    && typeof value.startTime === 'string' && /^[1-9]\d{0,29}$/.test(value.startTime);
}
const linuxProcessInspector = {
  async inspect(pid) {
    check(process.platform === 'linux', 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    let text;
    try { text = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw safeFailure('LOG_LOCK_IDENTITY_UNAVAILABLE'); }
    // comm may contain spaces/parentheses. Field 22 follows the final closing ')'.
    const startTime = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    check(/^[1-9]\d{0,29}$/.test(startTime || ''), 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    return { exists: true, startTime };
  },
  async current() {
    check(process.platform === 'linux', 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    let bootId;
    try { bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
    catch { throw safeFailure('LOG_LOCK_IDENTITY_UNAVAILABLE'); }
    const identity = await this.inspect(process.pid);
    const current = { pid: process.pid, bootId, startTime: identity.startTime };
    check(identity.exists && validIdentity(current), 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    return current;
  },
};

// No directory default and no environment-file reads: construction alone does no I/O.
// One process/writer per directory. io injection is only for isolated fault tests.
export function createAccountSecurityLog({ directory, now = Date.now, io = fs, processInspector = linuxProcessInspector, maxPending = 256, retentionHold = false } = {}) {
  const uid = process.getuid?.();
  const state = {
    configured: typeof directory === 'string' && path.isAbsolute(directory), ready: false, closed: false,
    written: 0, writeFailures: 0, invalidEvents: 0, droppedEvents: 0, pending: 0,
    lastSuccessAt: null, lastFailureAt: null, lastError: null, retentionMonths: 6,
  };
  let blocked = false;
  let closing = false;
  let tail = Promise.resolve();
  let lockHandle;
  let logHandle;
  let logDay;
  let lockPath;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 10000) {
    state.configured = false;
    state.lastError = 'LOG_INVALID_CONFIG';
  }
  function time() {
    const date = new Date(now());
    check(Number.isFinite(date.getTime()), 'LOG_CLOCK_INVALID');
    return date.toISOString();
  }
  function fail(error, fatal = true) {
    let code = 'LOG_IO_FAILED';
    try {
      if (['LOG_UNSAFE_STORAGE', 'LOG_IN_USE', 'LOG_CORRUPT_SEGMENT', 'LOG_CLOCK_INVALID', 'LOG_INVALID_EVENT', 'LOG_LOCK_IDENTITY_UNAVAILABLE'].includes(error?.securityLogCode)) code = error.securityLogCode;
      else if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') code = 'LOG_DISK_FULL';
    } catch { /* Never surface arbitrary exception properties or messages. */ }
    if (fatal) { blocked = true; state.writeFailures++; }
    state.lastError = code;
    try { state.lastFailureAt = time(); } catch { state.lastFailureAt = null; }
    return { ok: false, error: code };
  }
  function health() {
    return { ...state, healthy: state.configured && state.ready && !state.closed && !closing
      && !blocked && state.lastError === null, retentionHold: Boolean(retentionHold) };
  }
  async function syncDirectory(name) {
    const handle = await io.open(name, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function recoverExitedWriter(current) {
    const before = await io.lstat(lockPath);
    privateStat(before, false, uid);
    check(before.size > 0 && before.size <= 1024, 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    const reader = await io.open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let previous;
    try {
      const opened = await reader.stat();
      privateStat(opened, false, uid);
      check(before.ino === opened.ino && before.dev === opened.dev, 'LOG_UNSAFE_STORAGE');
      try { previous = JSON.parse(await reader.readFile('utf8')); }
      catch { throw safeFailure('LOG_LOCK_IDENTITY_UNAVAILABLE'); }
    } finally { await reader.close(); }
    check(previous?.version === 1 && validIdentity(previous), 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    async function verifyExited() {
      // A verified reboot proves every process from the old boot is gone.
      if (previous.bootId !== current.bootId) return;
      let observed;
      try { observed = await processInspector.inspect(previous.pid); }
      catch { throw safeFailure('LOG_LOCK_IDENTITY_UNAVAILABLE'); }
      if (observed?.exists === false) return;
      check(observed?.exists === true && typeof observed.startTime === 'string'
        && /^[1-9]\d{0,29}$/.test(observed.startTime), 'LOG_LOCK_IDENTITY_UNAVAILABLE');
      // Same PID with a different verified start identity is PID reuse, not the old writer.
      check(observed.startTime !== previous.startTime, 'LOG_IN_USE');
    }
    await verifyExited();
    const claim = `${lockPath}.recover-${randomUUID()}`;
    let claimed = false;
    try {
      // This hard link pins the examined inode. Any competing recovery sees an
      // unexpected link count and refuses; it cannot remove a replacement lock.
      await io.link(lockPath, claim);
      claimed = true;
      const pinned = await io.lstat(claim);
      privateStat(pinned, false, uid, 2);
      check(pinned.ino === before.ino && pinned.dev === before.dev, 'LOG_UNSAFE_STORAGE');
      await verifyExited();
      const latest = await io.lstat(lockPath);
      privateStat(latest, false, uid, 2);
      check(latest.ino === before.ino && latest.dev === before.dev, 'LOG_UNSAFE_STORAGE');
      await io.unlink(lockPath);
    } finally {
      if (claimed) await io.unlink(claim);
    }
  }
  async function initialize() {
    if (state.ready) return;
    // Check existing ancestors before mkdir, so a supplied symlink never redirects a write.
    for (let parent = directory; ; parent = path.dirname(parent)) {
      let stat;
      try { stat = await io.lstat(parent); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) check(stat.isDirectory() && !stat.isSymbolicLink(), 'LOG_UNSAFE_STORAGE');
      if (parent === path.dirname(parent)) break;
    }
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    privateStat(await io.lstat(directory), true, uid);
    await syncDirectory(path.dirname(directory));
    lockPath = path.join(directory, '.account-security-writer.lock');
    let identity;
    try { identity = await processInspector.current(); }
    catch { throw safeFailure('LOG_LOCK_IDENTITY_UNAVAILABLE'); }
    check(validIdentity(identity), 'LOG_LOCK_IDENTITY_UNAVAILABLE');
    try {
      lockHandle = await io.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await recoverExitedWriter(identity);
      try { lockHandle = await io.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
      catch (retry) { if (retry.code === 'EEXIST') throw safeFailure('LOG_IN_USE'); throw retry; }
    }
    await lockHandle.chmod(0o600);
    await lockHandle.writeFile(`${JSON.stringify({ version: 1, pid: identity.pid, bootId: identity.bootId, startTime: identity.startTime })}\n`);
    await lockHandle.sync();
    await syncDirectory(directory);
    state.ready = true;
  }
  async function append(entry) {
    const day = entry.time.slice(0, 10);
    let created = false;
    if (logDay !== day) {
      if (logHandle) { await logHandle.close(); logHandle = undefined; }
      const filename = path.join(directory, `account-security-${day}.ndjson`);
      let previous;
      try { previous = await io.lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) privateStat(previous, false, uid);
      logHandle = await io.open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600);
      if (!previous) { await logHandle.chmod(0o600); created = true; }
      const opened = await logHandle.stat();
      privateStat(opened, false, uid);
      if (previous) check(previous.ino === opened.ino && previous.dev === opened.dev, 'LOG_UNSAFE_STORAGE');
      if (opened.size) {
        const last = Buffer.alloc(1);
        await logHandle.read(last, 0, 1, opened.size - 1);
        check(last[0] === 10, 'LOG_CORRUPT_SEGMENT');
      }
      logDay = day;
    }
    const bytes = Buffer.from(`${JSON.stringify(entry)}\n`);
    for (let offset = 0; offset < bytes.length;) {
      const result = await logHandle.write(bytes, offset, bytes.length - offset, null);
      check(result.bytesWritten > 0, 'LOG_IO_FAILED');
      offset += result.bytesWritten;
    }
    await logHandle.sync();
    if (created) await syncDirectory(directory);
    state.written++;
    state.lastSuccessAt = entry.time;
    return { ok: true };
  }
  function enqueue(action, record = false) {
    if (!state.configured) return Promise.resolve({ ok: false, error: state.lastError || 'LOG_NOT_CONFIGURED' });
    if (closing || state.closed) return Promise.resolve({ ok: false, error: 'LOG_CLOSED' });
    if (state.pending >= maxPending) {
      if (record) state.droppedEvents++;
      state.lastError = 'LOG_QUEUE_FULL';
      try { state.lastFailureAt = time(); } catch { state.lastFailureAt = null; }
      return Promise.resolve({ ok: false, error: 'LOG_QUEUE_FULL' });
    }
    state.pending++;
    const operation = tail.then(async () => {
      if (blocked) { if (record) state.droppedEvents++; return { ok: false, error: state.lastError }; }
      try { await initialize(); return await action(); }
      catch (error) { if (record) state.droppedEvents++; return fail(error); }
    }).finally(() => { state.pending--; });
    tail = operation.then(() => {}, () => {});
    return operation;
  }
  return {
    ready: async () => { await enqueue(async () => ({ ok: true })); return health(); },
    health,
    record(input) {
      let entry;
      try { entry = makeEvent(input, time()); }
      catch { state.invalidEvents++; state.droppedEvents++; return Promise.resolve(fail(safeFailure('LOG_INVALID_EVENT'), false)); }
      return enqueue(() => append(entry), true);
    },
    flush: async () => { await tail; return health(); },
    prune({ apply = false } = {}) {
      return enqueue(async () => {
        const cutoff = accountSecurityRetentionCutoff(now()).toISOString().slice(0, 10);
        const candidates = [];
        for (const name of await io.readdir(directory)) {
          const match = SEGMENT.exec(name);
          // Never unlink the current append descriptor after a long idle period.
          if (!match || match[1] >= cutoff || match[1] === logDay) continue;
          const parsed = new Date(`${match[1]}T00:00:00.000Z`);
          if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1]) continue;
          privateStat(await io.lstat(path.join(directory, name)), false, uid);
          candidates.push(name);
        }
        candidates.sort();
        if (apply === true && !retentionHold) {
          for (const name of candidates) await io.unlink(path.join(directory, name));
        }
        return { ok: true, applied: apply === true && !retentionHold, held: Boolean(retentionHold), cutoff, candidates };
      });
    },
    async close() {
      closing = true;
      await tail;
      try {
        if (logHandle) { await logHandle.close(); logHandle = undefined; }
        if (lockHandle) {
          const owned = await lockHandle.stat();
          await lockHandle.close();
          lockHandle = undefined;
          const latest = await io.lstat(lockPath);
          check(latest.ino === owned.ino && latest.dev === owned.dev, 'LOG_UNSAFE_STORAGE');
          await io.unlink(lockPath);
        }
      } catch (error) { fail(error); }
      state.closed = true;
      return health();
    },
  };
}
