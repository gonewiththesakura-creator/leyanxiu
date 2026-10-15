// Default plan is local-only and never imports the credential-loading ECS helper.
// Mutating actions must be invoked explicitly against a reviewed bundle SHA-256.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.dirname(server);
const INSTANCE = 'REDACTED_COMPANY_CLOUD_INSTANCE';
const BASE = '/opt/leyanxiu-app-account';
const OLD = `${BASE}/releases/20260930-account`;
const RELEASE = `${BASE}/releases/20261009-account`;
const TESTS = [
  'account-security-log.test.mjs', 'account-runtime-config.test.mjs', 'account-retention.test.mjs',
  'account-operations.test.mjs', 'account-only.test.mjs', 'app-accounts.test.mjs',
  'payment-accounts.test.mjs', 'app-sms-config.test.mjs', 'account-bootstrap-consent.test.mjs',
];
const EXPLICIT = [
  'package.json', 'package-lock.json', 'scripts/app-billing-migrate.mjs', 'scripts/app-ecs-smoke.mjs',
  'deploy/update-app-sms-config.mjs', 'deploy/update-app-account-runtime.mjs',
  'deploy/activate-app-account-update.sh', 'deploy/app-account-index.html',
  ...TESTS.map(name => `tests/${name}`),
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const insist = (condition, code) => { if (!condition) throw new Error(code); };
const report = value => console.log(JSON.stringify(value));

export function allowedBundlePath(name) {
  return /^[A-Za-z0-9_.-]+\.js$/.test(name) && !/^(?:test|compare|upload|add|generate|_)/.test(name)
    || /^(?:accounts|payments|providers)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(name)
    || EXPLICIT.includes(name)
    || /^web\/app\/legal\/(?:terms|privacy)\.html$/.test(name);
}
export function buildAccountUpdateBundle() {
  const files = {};
  function include(name, source = path.join(server, name)) {
    insist(allowedBundlePath(name), 'BUNDLE_PATH_REJECTED');
    const stat = fs.lstatSync(source);
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.size < 8 * 1024 * 1024, 'BUNDLE_FILE_REJECTED');
    files[name] = fs.readFileSync(source).toString('base64');
  }
  for (const item of fs.readdirSync(server, { withFileTypes: true })) {
    if (item.isFile() && allowedBundlePath(item.name) && item.name.endsWith('.js')) include(item.name);
  }
  function collect(relative) {
    insist(!fs.lstatSync(path.join(server, relative)).isSymbolicLink(), 'BUNDLE_SYMLINK_REJECTED');
    for (const item of fs.readdirSync(path.join(server, relative), { withFileTypes: true })) {
      const name = `${relative}/${item.name}`;
      insist(!item.isSymbolicLink(), 'BUNDLE_SYMLINK_REJECTED');
      if (item.isDirectory()) collect(name);
      else if (item.isFile() && item.name.endsWith('.js')) include(name);
    }
  }
  for (const directory of ['accounts', 'payments', 'providers']) collect(directory);
  for (const name of EXPLICIT) include(name);
  for (const name of ['terms', 'privacy']) include(`web/app/legal/${name}.html`, path.join(app, 'public/app/legal', `${name}.html`));
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const payload = { format: 'app-account-update-v1', instanceId: INSTANCE, oldRelease: OLD, release: RELEASE, files: sorted };
  const bytes = zlib.gzipSync(JSON.stringify(payload));
  return { bytes, sha256: hash(bytes), payload };
}

export function validateAccountUpdateBundle(bytes, expectedHash) {
  insist(/^[a-f0-9]{64}$/.test(expectedHash) && hash(bytes) === expectedHash, 'BUNDLE_HASH_MISMATCH');
  const payload = JSON.parse(zlib.gunzipSync(bytes));
  insist(payload.format === 'app-account-update-v1' && payload.instanceId === INSTANCE
    && payload.oldRelease === OLD && payload.release === RELEASE, 'BUNDLE_TARGET_MISMATCH');
  insist(payload.files && typeof payload.files === 'object' && !Array.isArray(payload.files), 'BUNDLE_INVALID');
  for (const [name, value] of Object.entries(payload.files)) {
    insist(allowedBundlePath(name) && !name.split('/').some(part => part === '..' || part === '.'), 'BUNDLE_PATH_REJECTED');
    insist(typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value, 'BUNDLE_INVALID');
  }
  for (const name of EXPLICIT) insist(Object.hasOwn(payload.files, name), 'BUNDLE_REQUIRED_FILE_MISSING');
  return payload;
}

export function accountUpdateStageScript(bundle) {
  const incoming = `${BASE}/incoming-20261009-${bundle.sha256.slice(0, 16)}`;
  const parts = Math.ceil(bundle.bytes.length / 24000);
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
test "$EUID" -eq 0
test ! -e '${RELEASE}'
test -d '${OLD}/web'
for attempt in $(seq 1 30); do test -d '${incoming}' && break; sleep 1; done
test -d '${incoming}' && test ! -L '${incoming}'
chmod 0700 '${incoming}'
exec 3>&1
exec >/dev/null 2>&1
trap 'printf "APP_UPDATE_STAGE_FAILED\\n" >&3' ERR
python3 - <<'PY'
import pathlib,hashlib,gzip,json,base64,time,stat
incoming=pathlib.Path('${incoming}')
for attempt in range(60):
 parts=[incoming/('part-%04d'%n) for n in range(${parts})]
 if all(p.is_file() and not p.is_symlink() for p in parts):
  data=b''.join(p.read_bytes() for p in parts)
  if hashlib.sha256(data).hexdigest()=='${bundle.sha256}': break
 time.sleep(1)
else: raise SystemExit('APP_UPDATE_TRANSFER_UNCONFIRMED')
payload=json.loads(gzip.decompress(data))
assert payload['format']=='app-account-update-v1' and payload['instanceId']=='${INSTANCE}'
assert payload['oldRelease']=='${OLD}' and payload['release']=='${RELEASE}'
root=pathlib.Path('${RELEASE}')
root.mkdir(mode=0o750,parents=False,exist_ok=False)
for name,value in payload['files'].items():
 assert name in ${JSON.stringify(Object.keys(bundle.payload.files))}
 target=root/name
 assert target.resolve().is_relative_to(root.resolve())
 target.parent.mkdir(mode=0o750,parents=True,exist_ok=True)
 content=base64.b64decode(value,validate=True)
 target.write_bytes(content)
 target.chmod(0o640)
(root/'source-bundle.json.gz').write_bytes(data)
(root/'source-bundle.json.gz').chmod(0o600)
source={name:hashlib.sha256(base64.b64decode(value)).hexdigest() for name,value in payload['files'].items()}
manifest={'format':payload['format'],'release':payload['release'],'oldRelease':payload['oldRelease'],'bundleSha256':'${bundle.sha256}','files':source}
(root/'source-manifest.json').write_text(json.dumps(manifest,sort_keys=True))
(root/'source-manifest.json').chmod(0o640)
# Reuse only existing public asset types. No private state/config or arbitrary JSON.
old=pathlib.Path('${OLD}/web')
extensions={'.js','.css','.woff','.woff2','.png','.jpg','.jpeg','.webp','.svg','.ico','.mp4','.webm','.mp3','.m4a','.ogg'}
assets={}
for category in ['assets','plays','templates','avatars','effects','banners']:
 base=old/category
 if not base.exists(): continue
 assert base.is_dir() and not base.is_symlink()
 for file in base.rglob('*'):
  assert not file.is_symlink()
  if not file.is_file() or file.suffix.lower() not in extensions: continue
  name=file.relative_to(old)
  target=root/'web'/name
  assert not target.exists()
  target.parent.mkdir(mode=0o750,parents=True,exist_ok=True)
  content=file.read_bytes();target.write_bytes(content);target.chmod(0o640)
  assets[str(name)]=hashlib.sha256(content).hexdigest()
(root/'web/index.html').write_bytes((root/'deploy/app-account-index.html').read_bytes())
(root/'public-assets-manifest.json').write_text(json.dumps({'source':'${OLD}/web','files':assets},sort_keys=True))
PY
printf 'APP_UPDATE_SOURCE_PREPARED\\n' >&3
cd '${RELEASE}'
npm ci --omit=dev --no-audit --no-fund
printf 'APP_UPDATE_PROD_DEPENDENCIES_READY\\n' >&3
node --test tests/account-security-log.test.mjs tests/account-runtime-config.test.mjs tests/account-operations.test.mjs tests/account-only.test.mjs tests/app-sms-config.test.mjs
printf 'APP_UPDATE_ISOLATED_TESTS_PASSED\\n' >&3
node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {createAccountSecurityLog} from './accounts/security-log.js';
assert.equal(process.platform,'linux');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'lyx-app-log-crash-'));
const directory=path.join(temporary,'logs');
const url=pathToFileURL(path.resolve('accounts/security-log.js')).href;
let child,resumed;
try {
 const code='import {createAccountSecurityLog} from '+JSON.stringify(url)+';const log=createAccountSecurityLog({directory:process.argv[1]});if(!(await log.ready()).healthy)process.exit(2);if(!(await log.record({event:"device.verify",result:"attempt"})).ok)process.exit(3);console.log("READY");setInterval(()=>{},1000);';
 child=spawn(process.execPath,['--input-type=module','--eval',code,directory],{stdio:['ignore','pipe','ignore']});
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('CRASH_FIXTURE_TIMEOUT')),10000);
  let text='';child.stdout.on('data',chunk=>{text+=chunk.toString();if(text.includes('READY\\n')){clearTimeout(timer);resolve();}});
  child.once('error',()=>{clearTimeout(timer);reject(new Error('CRASH_FIXTURE_START_FAILED'));});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('CRASH_FIXTURE_EXITED'));});
 });
 const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 resumed=createAccountSecurityLog({directory});
 assert.equal((await resumed.ready()).healthy,true);
 assert.equal((await resumed.record({event:'device.verify',result:'success'})).ok,true);
 const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.ndjson'));
 const contents=(await Promise.all(files.map(name=>fs.readFile(path.join(directory,name),'utf8')))).join('');
 assert.equal(contents.trim().split('\\n').map(line=>JSON.parse(line)).length,2);
} finally {
 if(child && child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
 await resumed?.close();await fs.rm(temporary,{recursive:true,force:true});
}
JS
printf 'APP_UPDATE_LINUX_CRASH_RECOVERY_PASSED\\n' >&3
node --check index.js
bash -n deploy/activate-app-account-update.sh
chgrp -R leyanxiu-app '${RELEASE}'
find '${RELEASE}' -type d -exec chmod 0750 {} +
find '${RELEASE}' -type f ! -name source-bundle.json.gz -exec chmod g+r {} +
printf 'APP_UPDATE_STAGE_READY ${bundle.sha256}\\n' >&3
`;
}

async function main(args) {
  const action = args[0] || 'plan';
  if (action === 'status') {
    insist(args.length === 2 && /^t-[A-Za-z0-9]+$/.test(args[1]), 'INVALID_INVOCATION');
    const { request } = await import('./inspect-app-ecs.mjs');
    const result = await request('DescribeInvocationResults', { InvokeId: args[1], InstanceId: INSTANCE, ContentEncoding: 'PlainText' });
    report({ results: result.Invocation?.InvocationResults?.InvocationResult?.map(item => ({
      status: /^[A-Za-z]+$/.test(item.InvocationStatus) ? item.InvocationStatus : 'Unknown', exitCode: item.ExitCode,
      codes: String(item.Output || '').split(/\r?\n/).filter(line => /^APP_UPDATE_[A-Z_]+(?: [a-f0-9]{64})?$/.test(line)),
      counts: String(item.Output || '').split(/\r?\n/).flatMap(line => {
        try { const value=JSON.parse(line); if(value.code!=='APP_UPDATE_DRYRUN_COUNTS') return [];
          return [Object.fromEntries(Object.entries(value).filter(([key,item])=>key==='code'||(/^[A-Za-z]+$/.test(key)&&Number.isSafeInteger(item)&&item>=0)))];
        } catch { return []; }
      }),
    })) });
    return;
  }
  insist(['plan', 'build', 'upload', 'stage'].includes(action), 'INVALID_ACTION');
  const bundle = buildAccountUpdateBundle();
  validateAccountUpdateBundle(bundle.bytes, bundle.sha256);
  report({ code: 'APP_UPDATE_LOCAL_PLAN', files: Object.keys(bundle.payload.files).length, bytes: bundle.bytes.length,
    sha256: bundle.sha256, instanceId: INSTANCE, oldRelease: OLD, release: RELEASE, secretsIncluded: false });
  if (action === 'plan') { insist(args.length <= 1, 'INVALID_ARGUMENTS'); return; }
  if (action === 'build') {
    insist(args.length === 1, 'INVALID_ARGUMENTS');
    const output = path.join(app, 'output', 'app-account-update-20261009');
    fs.mkdirSync(output, { recursive: true });
    const filename = path.join(output, `account-update-${bundle.sha256}.json.gz`);
    if (fs.existsSync(filename)) insist(hash(fs.readFileSync(filename)) === bundle.sha256, 'LOCAL_ARTIFACT_MISMATCH');
    else fs.writeFileSync(filename, bundle.bytes, { flag: 'wx', mode: 0o600 });
    report({ code: 'APP_UPDATE_LOCAL_BUNDLE_READY', sha256: bundle.sha256 });
    return;
  }
  insist(args.length === 3 && args[1] === '--sha256' && args[2] === bundle.sha256, 'REVIEWED_BUNDLE_HASH_REQUIRED');
  const { request } = await import('./inspect-app-ecs.mjs');
  if (action === 'upload') {
    let count = 0;
    for (let offset = 0; offset < bundle.bytes.length; offset += 24000) {
      await request('SendFile', { 'InstanceId.1': INSTANCE, Name: `part-${String(count++).padStart(4, '0')}`,
        TargetDir: `${BASE}/incoming-20261009-${bundle.sha256.slice(0, 16)}`, ContentType: 'Base64',
        Content: bundle.bytes.subarray(offset, offset + 24000).toString('base64'), FileMode: '600', Overwrite: 'false' });
    }
    report({ code: 'APP_UPDATE_UPLOAD_DISPATCHED', parts: count, sha256: bundle.sha256 });
  } else {
    const result = await request('RunCommand', { 'InstanceId.1': INSTANCE, Type: 'RunShellScript', Name: 'leyanxiu-app-update-stage-20261009',
      CommandContent: Buffer.from(accountUpdateStageScript(bundle)).toString('base64'), ContentEncoding: 'Base64', Timeout: '1800', KeepCommand: 'false' });
    report({ code: 'APP_UPDATE_STAGE_DISPATCHED', invokeId: result.InvokeId, sha256: bundle.sha256 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  report({ error: /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'APP_UPDATE_OPERATION_FAILED' });
  process.exitCode = 1;
});
