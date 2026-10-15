// Explicit opt-in only: importing this module opens no file and reads no env.
// This journal must live outside the business restore/backup directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const ACCOUNT_ID = /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function assertPrivateJournalPath(filename, { allowMissing = false } = {}) {
  if (!path.isAbsolute(filename)) fail('DELETION_JOURNAL_PATH_INVALID');
  if (process.platform === 'win32') fail('DELETION_JOURNAL_POSIX_PERMISSIONS_REQUIRED');
  let cursor = path.resolve(filename);
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('DELETION_JOURNAL_PATH_UNSAFE');
    cursor = path.dirname(cursor);
  }
  const parent = fs.lstatSync(path.dirname(filename));
  if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) fail('DELETION_JOURNAL_PATH_UNSAFE');
  if (!fs.existsSync(filename) && allowMissing) return;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) fail('DELETION_JOURNAL_PATH_UNSAFE');
}

// verifyPath is a narrow test seam for Windows: production must retain the
// default POSIX permission check. SQLite writes/transactions are never mocked.
export function openAccountDeletionJournal({ file, readOnly = false, now = Date.now, verifyPath = assertPrivateJournalPath } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof readOnly !== 'boolean' || typeof now !== 'function') fail('DELETION_JOURNAL_OPTIONS_INVALID');
  let db;
  let healthy = false;
  let closed = false;
  let openedFile;
  try {
    verifyPath(file, { allowMissing: !readOnly });
    const exists = fs.existsSync(file);
    if (!exists && !readOnly) fs.closeSync(fs.openSync(file, 'wx', 0o600));
    db = new Database(file, { readonly: readOnly, fileMustExist: true, timeout: 5000 });
    if (!readOnly) {
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
    }
    if (!exists) {
      const createdAt = now();
      if (!timestamp(createdAt)) fail('DELETION_JOURNAL_CLOCK_INVALID');
      db.transaction(() => {
        db.exec('CREATE TABLE journal_meta (id INTEGER PRIMARY KEY CHECK(id=1), journal_id TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE deletion_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT UNIQUE NOT NULL, deleted_at INTEGER NOT NULL);');
        db.prepare('INSERT INTO journal_meta VALUES(1,?,?)').run(`journal_${crypto.randomUUID()}`, createdAt);
      }).immediate();
      // Make creation durable as well as the SQLite transaction contents.
      if (process.platform !== 'win32') {
        const fd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
    verifyPath(file);
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') fail('DELETION_JOURNAL_INVALID');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (JSON.stringify(tables) !== JSON.stringify(['deletion_events', 'journal_meta'])) fail('DELETION_JOURNAL_INVALID');
    openedFile = fs.lstatSync(file);
    healthy = true;
  } catch {
    try { db?.close(); } catch { /* Never expose file/SQLite errors. */ }
    fail('DELETION_JOURNAL_UNAVAILABLE');
  }
  function verifyCurrentFile() {
    verifyPath(file);
    const current = fs.lstatSync(file);
    if (current.ino !== openedFile.ino || current.dev !== openedFile.dev) fail('DELETION_JOURNAL_REPLACED');
  }
  function read() {
    if (closed || !healthy) fail('DELETION_JOURNAL_UNAVAILABLE');
    verifyCurrentFile();
    return db.transaction(() => {
      const meta = db.prepare('SELECT journal_id AS journalId,created_at AS coverageStartedAt FROM journal_meta WHERE id=1').get();
      const entries = db.prepare('SELECT sequence,account_id AS accountId,deleted_at AS deletedAt FROM deletion_events ORDER BY sequence').all();
      if (!meta || !/^journal_[a-f0-9-]{36}$/.test(meta.journalId) || !timestamp(meta.coverageStartedAt)) fail('DELETION_JOURNAL_INVALID');
      let previous = meta.coverageStartedAt;
      for (const [index, entry] of entries.entries()) {
        if (entry.sequence !== index + 1 || !ACCOUNT_ID.test(entry.accountId) || !timestamp(entry.deletedAt) || entry.deletedAt < previous) fail('DELETION_JOURNAL_INVALID');
        previous = entry.deletedAt;
      }
      const observedAt = now();
      if (!timestamp(observedAt) || observedAt < previous) fail('DELETION_JOURNAL_CLOCK_INVALID');
      return { entries, checkpoint: { version: 1, ...meta, sequence: entries.length, digest: digest({ meta, entries }), observedAt } };
    })();
  }
  function safe(operation) {
    try { return operation(); }
    catch { healthy = false; fail('DELETION_JOURNAL_UNAVAILABLE'); }
  }
  return {
    file: path.resolve(file),
    // Durable deletion intent: call after authorization, before deletion side
    // effects. A pending intent remains authoritative if the business write fails.
    recordDeletion(accountId) {
      if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) fail('DELETION_JOURNAL_ACCOUNT_INVALID');
      if (readOnly) fail('DELETION_JOURNAL_READ_ONLY');
      return safe(() => {
        if (closed || !healthy) fail('DELETION_JOURNAL_UNAVAILABLE');
        verifyCurrentFile();
        return db.transaction(() => {
          const existing = db.prepare('SELECT sequence FROM deletion_events WHERE account_id=?').get(accountId);
          if (existing) return { ok: true, sequence: existing.sequence, alreadyRecorded: true };
          const time = now();
          const latest = db.prepare('SELECT MAX(deleted_at) AS time FROM deletion_events').get().time;
          const start = db.prepare('SELECT created_at FROM journal_meta WHERE id=1').get().created_at;
          if (!timestamp(time) || time < Math.max(latest || 0, start)) fail('DELETION_JOURNAL_CLOCK_INVALID');
          const result = db.prepare('INSERT INTO deletion_events(account_id,deleted_at) VALUES(?,?)').run(accountId, time);
          return { ok: true, sequence: Number(result.lastInsertRowid), alreadyRecorded: false };
        }).immediate();
      });
    },
    checkpoint() { return safe(() => read().checkpoint); },
    // Private return value for recovery; callers must never log these entries.
    readVerified(trusted) {
      const value = safe(read);
      const current = value.checkpoint;
      if (!trusted || trusted.version !== 1 || !timestamp(trusted.observedAt) || trusted.observedAt > current.observedAt || current.observedAt - trusted.observedAt > 300_000
        || ['journalId', 'coverageStartedAt', 'sequence', 'digest'].some(key => trusted[key] !== current[key])) fail('DELETION_JOURNAL_CHECKPOINT_MISMATCH');
      return value;
    },
    health() { return { healthy: healthy && !closed, closed, readOnly }; },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
