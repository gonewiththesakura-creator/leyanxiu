import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { accountSecurityRetentionCutoff, createAccountSecurityLog, createSecurityRequestId } from '../accounts/security-log.js';

const accountId = `usr_${randomUUID()}`;
const event = () => ({ event: 'phone.verify', result: 'success', accountId, requestId: createSecurityRequestId(), statusCode: 200 });
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-security-log-test-'));
  const directory = path.join(root, 'logs');
  const metadata = stat => {
    // Windows lacks POSIX ownership/modes. Only adapt those mode bits for actual
    // temp-file tests; explicit unsafe-mode tests override these returned values.
    if (process.platform === 'win32') stat.mode = (stat.mode & ~0o7777) | (stat.isDirectory() ? 0o700 : 0o600);
    return stat;
  };
  const io = {
    ...fs, lstat: async name => metadata(await fs.lstat(name)),
    open: async (...args) => {
      // Windows cannot open directories for fsync. Linux production uses real
      // directory descriptors; local transaction tests emulate only that operation.
      if (process.platform === 'win32' && (await fs.lstat(args[0]).catch(() => null))?.isDirectory()) {
        return { sync: async () => {}, close: async () => {} };
      }
      const handle = await fs.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => metadata(await stat());
      return handle;
    },
  };
  const currentIdentity = { pid: process.pid, bootId: randomUUID(), startTime: '100' };
  const processInspector = {
    current: async () => currentIdentity,
    inspect: async pid => pid === currentIdentity.pid ? { exists: true, startTime: currentIdentity.startTime } : { exists: false },
  };
  const logs = [];
  const create = options => { const log = createAccountSecurityLog({ directory, io, processInspector, ...options }); logs.push(log); return log; };
  try { await run({ directory, io, create, currentIdentity, processInspector }); }
  finally { for (const log of logs) await log.close(); await fs.rm(root, { recursive: true, force: true }); }
}
async function records(directory) {
  const filenames = (await fs.readdir(directory)).filter(name => name.endsWith('.ndjson')).sort();
  return (await Promise.all(filenames.map(name => fs.readFile(path.join(directory, name), 'utf8')))).join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('unconfigured default never writes and reports unavailable', async () => {
  const log = createAccountSecurityLog({ io: new Proxy({}, { get() { throw new Error('I/O must not occur'); } }) });
  assert.equal((await log.ready()).healthy, false);
  assert.deepEqual(await log.record(event()), { ok: false, error: 'LOG_NOT_CONFIGURED' });
  await log.close();
});

test('only enumerated fields and internal IDs reach disk; raw payload/getters are never serialized', async () => {
  await fixture(async ({ directory, create }) => {
    const log = create();
    const input = { ...event(), phone: '13800000001', code: '123456', token: 'token-secret-value', key: 'private-key', query: '?token=REDACTED_SECRET body: { phone: '13800000001' }, message: 'sensitive-message', time: 'attacker timestamp' };
    Object.defineProperty(input, 'extra', { get() { throw new Error('secret getter'); }, enumerable: true });
    assert.deepEqual(await log.record(input), { ok: true });
    const [saved] = await records(directory);
    assert.deepEqual(Object.keys(saved).sort(), ['accountId', 'event', 'reason', 'requestId', 'result', 'statusCode', 'time', 'version']);
    const output = JSON.stringify(saved);
    for (const secret of ['13800000001', '123456', 'token-secret-value', 'private-key', '?token=REDACTED_SECRET 'sensitive-message', 'attacker timestamp']) assert.equal(output.includes(secret), false);
    assert.equal(saved.accountId, accountId);
    assert.equal(log.health().healthy, true);
  });
});

test('invalid IDs, free-text enums and malicious getters yield only fixed failures', async () => {
  await fixture(async ({ directory, create }) => {
    const log = create();
    await log.ready();
    for (const input of [{ ...event(), accountId: '13800000001' }, { ...event(), requestId: 'Bearer secret' }, { ...event(), reason: 'code=123456' }, { ...event(), event: 'token=secret' }, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private-phone-token'); } })]) {
      assert.deepEqual(await log.record(input), { ok: false, error: 'LOG_INVALID_EVENT' });
    }
    assert.equal((await records(directory)).length, 0);
    assert.equal(JSON.stringify(log.health()).includes('private-phone-token'), false);
    assert.equal(log.health().healthy, false);
  });
});

test('concurrent writes are complete durable lines and rotation never prunes by size', async () => {
  await fixture(async ({ directory, create }) => {
    let now = Date.parse('2026-10-09T12:00:00Z');
    const log = create({ now: () => now });
    const values = Array.from({ length: 120 }, event);
    const results = await Promise.all(values.map(value => log.record(value)));
    assert.equal(results.every(result => result.ok), true);
    now = Date.parse('2026-10-10T12:00:00Z');
    await log.record(event());
    const saved = await records(directory);
    assert.equal(saved.length, 121);
    assert.equal(new Set(saved.map(value => value.requestId)).size, 121);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.ndjson')).length, 2);
    assert.equal((await log.flush()).written, 121);
  });
});

test('a second writer is refused, and close releases its own directory lock', async () => {
  await fixture(async ({ create }) => {
    const first = create();
    assert.equal((await first.ready()).healthy, true);
    const second = create();
    assert.equal((await second.ready()).lastError, 'LOG_IN_USE');
    await second.close();
    const third = create();
    assert.equal((await third.ready()).lastError, 'LOG_IN_USE');
    await first.close();
    const reopened = create();
    assert.equal((await reopened.ready()).healthy, true);
    assert.deepEqual(await reopened.record(event()), { ok: true });
  });
});

test('confirmed exited process, reboot, and verified PID reuse recover a stale writer lock', async () => {
  for (const cause of ['exit', 'reboot', 'pid-reuse']) {
    await fixture(async ({ directory, create, currentIdentity }) => {
      await fs.mkdir(directory, { mode: 0o700 });
      const previous = { version: 1, ...currentIdentity };
      if (cause === 'exit') previous.pid += 42;
      if (cause === 'reboot') previous.bootId = randomUUID();
      if (cause === 'pid-reuse') previous.startTime = '99';
      const lockPath = path.join(directory, '.account-security-writer.lock');
      await fs.writeFile(lockPath, JSON.stringify(previous), { mode: 0o600 });
      const log = create();
      assert.equal((await log.ready()).healthy, true, cause);
      assert.equal((await log.record(event())).ok, true);
      assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), { version: 1, ...currentIdentity });
      assert.equal((await fs.readdir(directory)).some(name => name.includes('.recover-')), false);
    });
  }
});

test('unknown or incomplete lock identity is not reclaimed and does not leak diagnostics', async () => {
  for (const incomplete of [true, false]) {
    await fixture(async ({ directory, create, currentIdentity, processInspector }) => {
      await fs.mkdir(directory, { mode: 0o700 });
      const bytes = incomplete ? '{"pid":123}' : JSON.stringify({ version: 1, ...currentIdentity });
      const lockPath = path.join(directory, '.account-security-writer.lock');
      await fs.writeFile(lockPath, bytes, { mode: 0o600 });
      processInspector.inspect = async () => { throw new Error('token=raw-secret-value'); };
      const log = create();
      assert.equal((await log.ready()).lastError, 'LOG_LOCK_IDENTITY_UNAVAILABLE');
      assert.equal(await fs.readFile(lockPath, 'utf8'), bytes);
      assert.equal(JSON.stringify(log.health()).includes('raw-secret-value'), false);
    });
  }
});

test('recovery refuses to delete a lock replaced between identity check and inode claim', async () => {
  await fixture(async ({ directory, io, create, currentIdentity }) => {
    await fs.mkdir(directory, { mode: 0o700 });
    const lockPath = path.join(directory, '.account-security-writer.lock');
    await fs.writeFile(lockPath, JSON.stringify({ version: 1, ...currentIdentity, pid: currentIdentity.pid + 42 }), { mode: 0o600 });
    const currentBytes = JSON.stringify({ version: 1, ...currentIdentity });
    const link = io.link;
    io.link = async (source, destination) => {
      await fs.rename(source, `${source}.old-test-inode`);
      await fs.writeFile(source, currentBytes, { mode: 0o600 });
      return link(source, destination);
    };
    const log = create();
    assert.equal((await log.ready()).lastError, 'LOG_UNSAFE_STORAGE');
    assert.equal(await fs.readFile(lockPath, 'utf8'), currentBytes);
  });
});

test('concurrent stale-lock recovery admits at most one writer and keeps a valid lock', async () => {
  await fixture(async ({ directory, create, currentIdentity }) => {
    await fs.mkdir(directory, { mode: 0o700 });
    const lockPath = path.join(directory, '.account-security-writer.lock');
    await fs.writeFile(lockPath, JSON.stringify({ version: 1, ...currentIdentity, pid: currentIdentity.pid + 42 }), { mode: 0o600 });
    const first = create();
    const second = create();
    const outcomes = await Promise.all([first.ready(), second.ready()]);
    assert.ok(outcomes.filter(outcome => outcome.healthy).length <= 1);
    const winner = outcomes[0].healthy ? first : outcomes[1].healthy ? second : create();
    assert.equal((await winner.ready()).healthy, true);
    assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), { version: 1, ...currentIdentity });
    assert.equal((await winner.record(event())).ok, true);
  });
});

test('six-calendar-month retention preserves boundary day, supports dry-run and hold', async () => {
  assert.equal(accountSecurityRetentionCutoff('2027-08-31T23:59:59Z').toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(accountSecurityRetentionCutoff('2028-08-31T23:59:59Z').toISOString(), '2028-02-29T00:00:00.000Z');
  await fixture(async ({ directory, create }) => {
    let now = Date.parse('2026-04-08T23:59:59Z');
    const log = create({ now: () => now });
    await log.record(event());
    now = Date.parse('2026-04-09T00:00:00Z');
    await log.record(event());
    now = Date.parse('2026-10-09T20:00:00Z');
    const dry = await log.prune();
    assert.equal(dry.applied, false);
    assert.deepEqual(dry.candidates, ['account-security-2026-04-08.ndjson']);
    assert.equal((await records(directory)).length, 2);
    assert.equal((await log.prune({ apply: 'false' })).applied, false);
    assert.equal((await records(directory)).length, 2);
    await log.prune({ apply: true });
    assert.equal((await records(directory)).length, 1);
    await log.close();
    now = Date.parse('2027-10-09T20:00:00Z');
    const held = create({ now: () => now, retentionHold: true });
    assert.equal((await held.prune({ apply: true })).applied, false);
    assert.equal((await records(directory)).length, 1);
  });
});

test('disk-full or arbitrary I/O errors never masquerade as a recorded event or leak messages', async () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EACCES']) {
    await fixture(async ({ io, create }) => {
      const open = io.open;
      io.open = async (...args) => {
        if (args[0].endsWith('.ndjson')) throw Object.assign(new Error('phone=13800000001&token=REDACTED_SECRET { code });
        return open(...args);
      };
      const log = create();
      assert.equal((await log.record(event())).ok, false);
      assert.equal(log.health().healthy, false);
      assert.equal(log.health().written, 0);
      assert.equal(log.health().writeFailures, 1);
      assert.equal(JSON.stringify(log.health()).includes('13800000001'), false);
      assert.equal((await log.record(event())).ok, false);
    });
  }
});

test('an fsync failure is observable even after the entire line was written', async () => {
  await fixture(async ({ directory, io, create }) => {
    const open = io.open;
    io.open = async (...args) => {
      const handle = await open(...args);
      if (args[0].endsWith('.ndjson')) handle.sync = async () => { throw new Error('raw-secret-value'); };
      return handle;
    };
    const log = create();
    assert.deepEqual(await log.record({ ...event(), result: 'attempt' }), { ok: false, error: 'LOG_IO_FAILED' });
    assert.equal((await records(directory)).length, 1);
    assert.equal(log.health().written, 0);
    assert.equal(log.health().healthy, false);
    assert.equal(JSON.stringify(log.health()).includes('raw-secret-value'), false);
  });
});

test('pruning never unlinks an old active append descriptor after extended idle', async () => {
  await fixture(async ({ directory, create }) => {
    let now = Date.parse('2026-01-01T12:00:00Z');
    const log = create({ now: () => now });
    await log.record(event());
    now = Date.parse('2026-10-09T12:00:00Z');
    assert.deepEqual((await log.prune({ apply: true })).candidates, []);
    await log.record(event());
    assert.deepEqual((await log.prune({ apply: true })).candidates, ['account-security-2026-01-01.ndjson']);
    assert.equal((await records(directory)).length, 1);
  });
});

test('partial write failure blocks later append and restart refuses a truncated segment', async () => {
  await fixture(async ({ directory, io, create }) => {
    const open = io.open;
    io.open = async (...args) => {
      const handle = await open(...args);
      if (args[0].endsWith('.ndjson')) {
        const write = handle.write.bind(handle);
        let first = true;
        handle.write = async (bytes, offset, length, position) => {
          if (!first) throw Object.assign(new Error('private failure'), { code: 'ENOSPC' });
          first = false;
          return write(bytes, offset, Math.min(length, 9), position);
        };
      }
      return handle;
    };
    const log = create({ now: () => Date.parse('2026-10-09T12:00:00Z') });
    assert.equal((await log.record(event())).error, 'LOG_DISK_FULL');
    assert.equal(log.health().written, 0);
    assert.equal((await log.record(event())).ok, false);
    await log.close();
    io.open = open;
    const resumed = create({ now: () => Date.parse('2026-10-09T13:00:00Z') });
    assert.equal((await resumed.record(event())).error, 'LOG_CORRUPT_SEGMENT');
    const raw = await fs.readFile(path.join(directory, 'account-security-2026-10-09.ndjson'));
    assert.equal(raw.length, 9);
  });
});

test('unsafe directory/file modes and symlinks are rejected before logging', async () => {
  for (const fault of ['directory-mode', 'file-mode', 'symlink']) {
    await fixture(async ({ directory, io, create }) => {
      await fs.mkdir(directory, { mode: 0o700 });
      const filename = path.join(directory, 'account-security-2026-10-09.ndjson');
      await fs.writeFile(filename, '', { mode: 0o600 });
      const lstat = io.lstat;
      io.lstat = async name => {
        const stat = await lstat(name);
        if (fault === 'directory-mode' && name === directory) stat.mode = 0o40755;
        if (fault === 'file-mode' && name === filename) stat.mode = 0o100644;
        if (fault === 'symlink' && name === filename) stat.isSymbolicLink = () => true;
        return stat;
      };
      const log = create({ now: () => Date.parse('2026-10-09T12:00:00Z') });
      assert.equal((await log.record(event())).error, 'LOG_UNSAFE_STORAGE');
      assert.equal(await fs.readFile(filename, 'utf8'), '');
    });
  }
});

test('queue pressure exposes dropped events instead of claiming success', async () => {
  await fixture(async ({ create }) => {
    const log = create({ maxPending: 1 });
    const first = log.record(event());
    assert.deepEqual(await log.record(event()), { ok: false, error: 'LOG_QUEUE_FULL' });
    assert.equal((await first).ok, true);
    assert.equal(log.health().written, 1);
    assert.equal(log.health().droppedEvents, 1);
    assert.equal(log.health().healthy, false);
  });
});
