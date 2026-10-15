import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Generates local private data only. No database, provider, browser or cloud calls.
// Never replaces an existing credential or prints a password.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filename = path.join(server, '.env.mini-production-db');
const expected = { XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_production', XPAY_MYSQL_USER: 'lyx_xpay_prod', XPAY_MYSQL_ACCOUNT_HOST: '%' };
try {
  if (process.argv.length !== 3 || !['--prepare', '--check'].includes(process.argv[2])) throw new Error('invalid arguments');
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  let created = false;
  if (!fs.existsSync(filename)) {
    if (process.argv[2] !== '--prepare') throw new Error('missing file');
    const fd = fs.openSync(filename, 'wx', 0o600);
    try {
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
        if (!sid) throw new Error('identity unavailable');
        execFileSync('icacls.exe', [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
      }
      const values = { ...expected, XPAY_MYSQL_PASSWORD: `Aa1!${crypto.randomBytes(32).toString('base64url')}` };
      fs.writeFileSync(fd, '# Local production DB credential; cloud creation/grants must be verified separately.\n'
        + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      fs.fsyncSync(fd); created = true;
    } finally { fs.closeSync(fd); }
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid file');
  const saved = dotenv.parse(fs.readFileSync(filename));
  if (Object.keys(saved).length !== 4 || Object.entries(expected).some(([key, value]) => saved[key] !== value)
    || !/^Aa1![A-Za-z0-9_-]{43}$/.test(saved.XPAY_MYSQL_PASSWORD || '')) throw new Error('invalid credential');
  console.log(JSON.stringify({ file: filename, created, existingValuesPreserved: true, passwordPresent: true,
    database: expected.XPAY_MYSQL_DATABASE, account: expected.XPAY_MYSQL_USER, cloudOperationPerformed: false }));
} catch {
  console.error('PRODUCTION_DB_CREDENTIAL_UNCONFIRMED: no secret values logged, existing files preserved');
  process.exitCode = 1;
}
