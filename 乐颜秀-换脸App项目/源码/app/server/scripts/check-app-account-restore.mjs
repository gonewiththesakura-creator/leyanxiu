// Default plan performs no I/O. Explicit checks read only isolated copies and
// never load .env. This is not a restore, a deployment, or permission to reopen.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { assertPrivateJournalPath, openAccountDeletionJournal } from '../deploy/account-deletion-journal.mjs';
import { captureAccountRestoreBaseline, checkAccountRestore } from '../deploy/account-restore-guard.mjs';

const fail = () => { throw new Error('RESTORE_CHECK_INPUT_INVALID'); };
const report = value => console.log(JSON.stringify(value));
function privateJson(file) {
  if (typeof file !== 'string' || !file.endsWith('.json')) fail();
  assertPrivateJournalPath(file);
  if (fs.statSync(file).size > 16_384) fail();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const under = (file, root) => { const relative = path.relative(root, file); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export async function runRestoreCheckCli(args) {
  if (!args.length || args.length === 1 && args[0] === '--plan') {
    return { version: 1, code: 'RESTORE_CHECK_PLAN_ONLY', mode: 'dry-run', readsConfiguration: false, readsDatabase: false, reopenAllowed: false };
  }
  const mode = args[0];
  if (!['--check', '--capture-baseline'].includes(mode)) fail();
  const required = mode === '--check'
    ? ['--identity', '--restore-root', '--pg-connection-file', '--journal', '--checkpoint', '--baseline', '--backup-at']
    : ['--identity', '--restore-root', '--pg-connection-file', '--output'];
  const options = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!required.includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) fail();
    options[args[i]] = args[i + 1];
  }
  if (required.some(key => !options[key])) fail();
  if (!path.isAbsolute(options['--restore-root']) || !path.isAbsolute(options['--identity'])) fail();
  assertPrivateJournalPath(options['--identity']);
  const config = privateJson(options['--pg-connection-file']);
  if (!config || Object.keys(config).join() !== 'connectionString') fail();
  const url = new URL(config.connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/lyx_app_restore_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) fail();
  let journal;
  let trustedCheckpoint;
  let baseline;
  if (mode === '--check') {
    if (under(options['--checkpoint'], options['--restore-root'])) fail();
    trustedCheckpoint = privateJson(options['--checkpoint']);
    baseline = privateJson(options['--baseline']);
    // Never create a journal while checking an old backup.
    journal = openAccountDeletionJournal({ file: options['--journal'], readOnly: true });
  } else {
    if (!options['--output'].endsWith('.json')) fail();
    assertPrivateJournalPath(options['--output'], { allowMissing: true });
    if (fs.existsSync(options['--output'])) fail();
  }
  const client = new Client({ connectionString: config.connectionString, options: '-c default_transaction_read_only=on', application_name: 'leyanxiu-account-restore-check', connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  client.on('error', () => {}); // Never log driver errors or the connection string.
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const db = { query(sql, params) { if (!/^SELECT\s/i.test(sql)) fail(); return client.query(sql, params); } };
    const copies = { db, identityFile: options['--identity'], restoreRoot: options['--restore-root'] };
    if (mode === '--check') return await checkAccountRestore({ ...copies, journal, trustedCheckpoint, baseline, backupTakenAt: Number(options['--backup-at']) });
    const value = await captureAccountRestoreBaseline(copies);
    const fd = fs.openSync(options['--output'], 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(path.dirname(options['--output']), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return { version: 1, code: 'RESTORE_BASELINE_CAPTURED', mode: 'dry-run', databaseWrites: false, reopenAllowed: false };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    journal?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRestoreCheckCli(process.argv.slice(2)).then(value => { report(value); if (value.ok === false) process.exitCode = 1; }).catch(() => {
    report({ code: 'RESTORE_CHECK_FAILED', mode: 'dry-run', ok: false, reopenAllowed: false }); process.exitCode = 1;
  });
}
