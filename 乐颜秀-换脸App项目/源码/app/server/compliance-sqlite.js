import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

// One local persistent filesystem shared by processes on the same host only.
// Do not place WAL databases on NFS/OSS or copy a live .db without its WAL.
export function createComplianceSqlite(filename, initialState) {
  if (!filename || !path.isAbsolute(filename) || filename === ':memory:') {
    throw new Error('COMPLIANCE_SQLITE_FILE_MUST_BE_EXPLICIT_ABSOLUTE_PATH');
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename, { timeout: 10000 });
  try {
    fs.chmodSync(filename, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec('CREATE TABLE IF NOT EXISTS compliance_snapshot (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)');
    db.prepare('INSERT OR IGNORE INTO compliance_snapshot(id,payload) VALUES(1,?)').run(JSON.stringify(initialState()));
  } catch (error) { db.close(); throw error; }
  const read = db.prepare('SELECT payload FROM compliance_snapshot WHERE id=1');
  const write = db.prepare('UPDATE compliance_snapshot SET payload=? WHERE id=1');
  const transact = db.transaction(callback => {
    const before = read.get().payload;
    const snapshot = JSON.parse(before);
    if (snapshot.schemaVersion !== 1) throw new Error('UNSUPPORTED_COMPLIANCE_SCHEMA');
    const outcome = callback(snapshot);
    if (!outcome || typeof outcome.then === 'function') throw new Error('COMPLIANCE_TRANSACTION_MUST_BE_SYNCHRONOUS');
    const bytes = JSON.stringify(outcome.state);
    if (bytes !== before) write.run(bytes);
    return outcome.result;
  });
  return {
    transact: callback => transact.immediate(callback),
    close: () => db.close(),
    backup: filename => db.backup(filename),
    readiness: () => ({ backend: 'sqlite-wal', durable: true, transactional: true, singleHostOnly: true, singleInstanceOnly: false, multiHostSupported: false, backupRestoreVerified: false }),
  };
}

export function sqliteProductionEvidence(env = process.env) {
  const blockers = [];
  if (env.COMPLIANCE_SQLITE_VOLUME !== 'single_host_persistent') blockers.push('single-host persistent local volume must be explicitly confirmed');
  try {
    const bytes = fs.readFileSync(env.COMPLIANCE_SQLITE_EVIDENCE_FILE || '');
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!env.COMPLIANCE_SQLITE_EVIDENCE_SHA256 || hash !== env.COMPLIANCE_SQLITE_EVIDENCE_SHA256) throw new Error('evidence digest mismatch');
    const evidence = JSON.parse(bytes);
    const age = Date.now() - Date.parse(evidence.createdAt);
    if (evidence.version !== 1 || evidence.restoreVerified !== true || evidence.database !== path.resolve(env.COMPLIANCE_SQLITE_FILE || '') || !Number.isFinite(age) || age < -300000 || age > 30 * 86400000) throw new Error('evidence missing, stale or for another database');
    const backupHash = crypto.createHash('sha256').update(fs.readFileSync(evidence.backup)).digest('hex');
    if (backupHash !== evidence.backupSha256) throw new Error('verified backup missing or changed');
  } catch { blockers.push('valid backup/restore report and matching backup required (maximum age 30 days)'); }
  return { ready: blockers.length === 0, backupRestoreVerified: !blockers.some(item => item.startsWith('valid backup')), blockers };
}
