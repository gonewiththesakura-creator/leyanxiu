import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createComplianceSqlite } from '../compliance-sqlite.js';

// Run offline with all writers stopped. Omit --source to verify a new backup
// of an existing SQLite database. Never overwrite source, database or evidence.
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--source','--database','--backup','--report'].includes(process.argv[i]) || !process.argv[i+1]) throw new Error('invalid arguments');
  options[process.argv[i].slice(2)] = path.resolve(process.argv[i+1]);
}
const { source, database, backup, report } = options;
if (!database || !backup || !report) throw new Error('--database --backup --report are required');
if (new Set(Object.values(options)).size !== Object.values(options).length) throw new Error('paths must be distinct');
for (const target of [backup, report, ...(source ? [database] : [])]) if (fs.existsSync(target)) throw new Error('refusing overwrite');
if (!source && !fs.existsSync(database)) throw new Error('database must exist without --source');
let imported;
if (source) {
  imported = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!imported || imported.schemaVersion !== 1) throw new Error('unsupported source schema');
  for (const key of ['users','sessions','orders','entitlements']) if (!imported[key] || typeof imported[key] !== 'object' || Array.isArray(imported[key])) throw new Error('invalid source map');
  if (!Array.isArray(imported.ledger)) throw new Error('invalid source ledger');
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
if (source) {
  fs.mkdirSync(path.dirname(database), {recursive:true,mode:0o700});
  fs.closeSync(fs.openSync(database,'wx',0o600));
}
const db = createComplianceSqlite(database, () => ({ schemaVersion: 1 }));
let snapshotDigest;
try {
  if (imported) db.transact(() => ({ state: imported, result: null }));
  snapshotDigest = db.transact(state => ({ state, result: digest(JSON.stringify(state)) }));
  fs.mkdirSync(path.dirname(backup), {recursive:true,mode:0o700});
  // Reserve exclusively before backup to protect a concurrent operator's file.
  fs.closeSync(fs.openSync(backup,'wx',0o600));
  await db.backup(backup);
} finally { db.close(); }
const verificationDir = fs.mkdtempSync(path.join(os.tmpdir(),'lyx-restore-'));
try {
  const restoredPath = path.join(verificationDir,'restore.db');
  fs.copyFileSync(backup,restoredPath,fs.constants.COPYFILE_EXCL);
  const restored = createComplianceSqlite(restoredPath, () => ({schemaVersion:1}));
  try {
    const restoredDigest = restored.transact(state => ({state,result:digest(JSON.stringify(state))}));
    if (restoredDigest !== snapshotDigest) throw new Error('restore digest mismatch');
  } finally { restored.close(); }
} finally { fs.rmSync(verificationDir,{recursive:true}); }
const evidence = { version:1, createdAt:new Date().toISOString(), database, backup, restoreVerified:true, snapshotDigest, backupSha256:digest(fs.readFileSync(backup)) };
const bytes = Buffer.from(JSON.stringify(evidence,null,2));
fs.mkdirSync(path.dirname(report),{recursive:true,mode:0o700});
fs.writeFileSync(report,bytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({restoreVerified:true,report,evidenceSha256:digest(bytes)}));
