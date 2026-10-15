// Read-only gate for already isolated PG/PGlite + SQLite copies. No env loading,
// connections, default paths, restore mutation, SMS, timers, or service activation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const FINANCIAL_TABLES = ['billing_accounts', 'billing_instance', 'billing_catalog', 'billing_orders', 'billing_events', 'billing_grants', 'billing_reservations', 'billing_refunds', 'billing_ledger', 'billing_audit', 'billing_reconciliation'];
const AUTH_TABLES = ['billing_phones', 'billing_devices', 'billing_otp', 'app_login_devices', 'app_login_identities', 'app_login_challenges'];
const ALL_TABLES = [...FINANCIAL_TABLES, ...AUTH_TABLES].sort();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const within = (child, parent) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };

function identitySnapshot(file, root) {
  if (!path.isAbsolute(file || '') || !path.isAbsolute(root || '') || !within(file, root)) fail('RESTORE_ISOLATION_REQUIRED');
  let cursor = path.resolve(file);
  while (cursor !== path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('RESTORE_PATH_UNSAFE');
    cursor = path.dirname(cursor);
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) fail('RESTORE_PATH_UNSAFE');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') fail('RESTORE_IDENTITY_INVALID');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 1 || tables[0].name !== 'compliance_snapshot') fail('RESTORE_IDENTITY_INVALID');
    const row = db.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get();
    const state = JSON.parse(row?.payload);
    if (state.schemaVersion !== 1 || !Array.isArray(state.consents) || !Array.isArray(state.ledger)) fail('RESTORE_IDENTITY_INVALID');
    for (const name of ['users', 'sessions', 'authChallenges', 'orders', 'refunds', 'paymentEvents', 'entitlements']) if (!state[name] || Array.isArray(state[name]) || typeof state[name] !== 'object') fail('RESTORE_IDENTITY_INVALID');
    for (const [id, user] of Object.entries(state.users)) if (!user || user.id !== id) fail('RESTORE_IDENTITY_INVALID');
    return state;
  } finally { db.close(); }
}

async function inspectCopies({ db, identityFile, restoreRoot }) {
  if (typeof db?.query !== 'function') fail('RESTORE_DATABASE_REQUIRED');
  const names = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename).sort();
  if (JSON.stringify(names) !== JSON.stringify(ALL_TABLES)) fail('RESTORE_SCHEMA_UNRECOGNIZED');
  const tables = {};
  for (const name of ALL_TABLES) {
    const rows = (await db.query(`SELECT * FROM ${name}`)).rows;
    tables[name] = rows.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  const identity = identitySnapshot(identityFile, restoreRoot);
  const financial = { tables: Object.fromEntries(FINANCIAL_TABLES.map(name => [name, tables[name]])), identity: Object.fromEntries(['orders', 'refunds', 'paymentEvents', 'entitlements', 'ledger'].map(name => [name, identity[name]])) };
  // These fields preserve the entire SMS budget, including unsuccessful sends.
  const counters = tables.billing_otp.map(row => canonical(Object.fromEntries(['id', 'phone_hash', 'device_user_id', 'ip_hash', 'created_at', 'attempts', 'sent', 'purpose'].map(key => [key, row[key]]))))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { tables, identity, baseline: { version: 1, financialDigest: hash(financial), antiAbuseDigest: hash(counters), consentDigest: hash(identity.consents) } };
}

export async function captureAccountRestoreBaseline(options) {
  try { return (await inspectCopies(options)).baseline; }
  catch { fail('RESTORE_BASELINE_UNAVAILABLE'); }
}

export async function checkAccountRestore({ db, identityFile, restoreRoot, journal, trustedCheckpoint, backupTakenAt, baseline } = {}) {
  // Passing is only this deletion/credential gate; it never authorizes reopening.
  const result = { version: 1, mode: 'dry-run', ok: false, reopenAllowed: false, code: 'RESTORE_CHECK_FAILED', counts: {} };
  if (!journal || !trustedCheckpoint) return { ...result, code: 'RESTORE_INDEPENDENT_JOURNAL_REQUIRED' };
  try {
    if (!path.isAbsolute(restoreRoot || '') || !path.isAbsolute(journal.file || '') || within(journal.file, restoreRoot) || path.resolve(journal.file) === path.resolve(restoreRoot)) return { ...result, code: 'RESTORE_JOURNAL_NOT_INDEPENDENT' };
    const { entries, checkpoint } = journal.readVerified(trustedCheckpoint);
    if (!Number.isSafeInteger(backupTakenAt) || backupTakenAt < checkpoint.coverageStartedAt || backupTakenAt > trustedCheckpoint.observedAt) return { ...result, code: 'RESTORE_JOURNAL_COVERAGE_MISSING' };
    if (!baseline || baseline.version !== 1 || ['financialDigest', 'antiAbuseDigest', 'consentDigest'].some(key => !/^[a-f0-9]{64}$/.test(baseline[key] || ''))) return { ...result, code: 'RESTORE_BASELINE_REQUIRED' };
    const current = await inspectCopies({ db, identityFile, restoreRoot });
    const { identity, tables } = current;
    const deleted = new Set(entries.map(row => row.accountId));
    const count = rows => rows.length;
    const counts = {
      deletionRecords: entries.length,
      resurrectedUsers: count(Object.values(identity.users).filter(user => deleted.has(user.id) && (user.status !== 'deleted' || !Number.isFinite(Date.parse(user.deletedAt)) || user.subjectHash != null))),
      deletedPhoneBindings: count(tables.billing_phones.filter(row => deleted.has(row.user_id))),
      deletedExternalIdentities: count(tables.app_login_identities.filter(row => deleted.has(row.user_id))),
      usableSessions: count(Object.values(identity.sessions).filter(row => !row.revokedAt || row.tokenHash != null)),
      usableDeviceChallenges: count(Object.values(identity.authChallenges).filter(row => !row.usedAt)),
      usableOtp: count(tables.billing_otp.filter(row => row.code_hash !== '' || row.consumed !== true)),
      usableLoginChallenges: count(tables.app_login_challenges.filter(row => row.consumed !== true)),
      usableDeviceMappings: count(tables.app_login_devices.filter(row => row.user_id !== null || Number(row.expires_at) !== 0)),
      usableLegacyAliases: count(tables.billing_devices.filter(row => row.disabled !== true)),
    };
    const preserved = Object.fromEntries(['financialDigest', 'antiAbuseDigest', 'consentDigest'].map(key => [key, current.baseline[key] === baseline[key]]));
    const unchanged = Object.values(preserved).every(Boolean);
    const safe = Object.entries(counts).every(([key, value]) => key === 'deletionRecords' || value === 0);
    // Recheck after all reads; a concurrent new deletion invalidates the result.
    journal.readVerified(trustedCheckpoint);
    return { ...result, ok: unchanged && safe, code: !unchanged ? 'RESTORE_PRESERVED_DATA_CHANGED' : safe ? 'RESTORE_DELETION_GATE_PASSED' : 'RESTORE_REPLAY_REQUIRED', counts, preserved };
  } catch {
    // Never return SQL rows, account IDs, filenames, parameters, or raw errors.
    return { ...result, code: 'RESTORE_CHECK_FAILED' };
  }
}
