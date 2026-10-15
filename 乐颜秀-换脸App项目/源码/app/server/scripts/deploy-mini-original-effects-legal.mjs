// A separate, pinned refresh of terms.html only. The historical deployment
// contracts and journals remain unchanged. Import and plan are local-only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { buildLegalBundle, validateLegalBundle, LEGAL_TARGET, LEGAL_PAGES, LEGAL_REFRESH_BASELINE,
  LEGAL_REFRESH_TARGET_SHA256 } from './deploy-mini-legal-static.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const insist = (ok, suffix) => { if (!ok) throw Error(`ORIGINAL_LEGAL_${suffix}`); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}-[A-Za-z0-9]+$`).test(value);
const clone = value => JSON.parse(JSON.stringify(value));
export const ORIGINAL_LEGAL_REVIEW = Object.freeze({
  bundleSha256: '5fd1a881060a0b1c5279e4c48cd40f6ff179dfbc27f9db8250fa4ab110723a0f',
  factsSha256: '82206d8ef6dd1e4995224a878100a5ff0df99015df3d1aba0a88175da7ce7dce',
  oldFactsSha256: '7f005c753ab71523a1108e83725a488f8d3991f8e1f1d2940b8c84f41c83d983',
  baselineBundleSha256: LEGAL_REFRESH_TARGET_SHA256,
  siteSha256: LEGAL_REFRESH_BASELINE.siteSha256, snippetSha256: LEGAL_REFRESH_BASELINE.snippetSha256,
  files: Object.freeze({
    'privacy.html': Object.freeze({ bytes: 12574, sha256: 'cccb8006f2ad073ea757f5621c2199c949a3f94b12dd8f641783128c5396169f' }),
    'terms.html': Object.freeze({ bytes: 12176, sha256: 'fdcf1675f2f21477cb892e2b6f23737ff6d3dc2e18abd1f17e3902aa68d64216' }),
    'third-parties.html': Object.freeze({ bytes: 8213, sha256: '0099e07b443855dab5cba880a86cdd617f3d2ed324594fc4ea4dbf181c7ea663' }),
  }),
  terms: Object.freeze({ bytes: 12392, sha256: '33bdca5764f0e637d43b7e4fb7b8400fe477b1812f96207b90e25b8d9ce5ea19' }),
});
const incoming = `/var/www/.leyanxiu-original-effects-legal-${ORIGINAL_LEGAL_REVIEW.bundleSha256}.json.gz`;
const remoteWork = `/var/www/.leyanxiu-original-effects-legal-${ORIGINAL_LEGAL_REVIEW.bundleSha256}`;
function regular(filename, limit = 65536) {
  const s = fs.lstatSync(filename);
  insist(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size > 0 && s.size <= limit
    && fs.realpathSync(filename) === path.resolve(filename), 'FILE_REJECTED');
  const bytes = fs.readFileSync(filename); insist(bytes.length === s.size, 'FILE_CHANGED'); return bytes;
}
export function validateOriginalLegalBundle(bundle) {
  const payload = validateLegalBundle(bundle.bytes, bundle.sha256), m = payload.manifest;
  insist(bundle.sha256 === ORIGINAL_LEGAL_REVIEW.bundleSha256 && same(m, bundle.manifest)
    && m.siteSha256 === ORIGINAL_LEGAL_REVIEW.siteSha256 && m.snippetSha256 === ORIGINAL_LEGAL_REVIEW.snippetSha256
    && same(m.files, { ...ORIGINAL_LEGAL_REVIEW.files, 'terms.html': ORIGINAL_LEGAL_REVIEW.terms }), 'REVIEW_CHANGED');
  return payload;
}
export function buildOriginalLegalBundle({ appRoot = app } = {}) {
  const baseline = buildLegalBundle({ appRoot });
  insist(baseline.sha256 === ORIGINAL_LEGAL_REVIEW.baselineBundleSha256
    && same(baseline.manifest.files, ORIGINAL_LEGAL_REVIEW.files), 'BASELINE_CHANGED');
  const payload = validateLegalBundle(baseline.bytes, baseline.sha256);
  for (const name of LEGAL_PAGES) {
    const bytes = regular(path.join(appRoot, 'output/original-effects-20261015/legal-candidate', name));
    const expected = name === 'terms.html' ? ORIGINAL_LEGAL_REVIEW.terms : ORIGINAL_LEGAL_REVIEW.files[name];
    insist(bytes.length === expected.bytes && sha(bytes) === expected.sha256, 'CANDIDATE_CHANGED');
    payload.manifest.files[name] = { ...expected };
    payload.files[name] = { ...expected, content: bytes.toString('base64') };
  }
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const bundle = { bytes, sha256: sha(bytes), manifest: payload.manifest };
  validateOriginalLegalBundle(bundle); return bundle;
}

// Pure preparation only. A future version deployment must independently pin its
// live source and legal HTTP readback; this never updates 017 or any cloud base.
export function prepareOriginalEffectsFacts(variables, { appRoot = app } = {}) {
  const beforeBytes = regular(path.join(appRoot, 'server/docs/production-config/natural-avatar-merchant-public-facts-2026-10-13.json'));
  const afterBytes = regular(path.join(appRoot, 'server/docs/production-config/original-effects-public-facts-2026-10-15.json'));
  insist(sha(beforeBytes) === ORIGINAL_LEGAL_REVIEW.oldFactsSha256 && sha(afterBytes) === ORIGINAL_LEGAL_REVIEW.factsSha256, 'FACTS_CHANGED');
  const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes), expected = clone(before);
  expected.aiServiceDisclosures[0].purpose = after.aiServiceDisclosures[0].purpose;
  insist(same(expected, after), 'FACTS_SCOPE_CHANGED');
  insist(variables && Object.getPrototypeOf(variables) === Object.prototype && Object.values(variables).every(v => typeof v === 'string')
    && variables.XPAY_ENV === '0' && variables.XPAY_MODE === 'merchant_test', 'CURRENT_SCOPE_REJECTED');
  const unchanged = { PRIVACY_POLICY_URL: before.publicDocuments.privacyPolicyUrl, USER_AGREEMENT_URL: before.publicDocuments.userAgreementUrl,
    THIRD_PARTY_LIST_URL: before.publicDocuments.thirdPartyListUrl, RETENTION_SUPPLIER_POLICY: before.retentionSupplierPolicy, PIPIA_REFERENCE: before.pipiaReference };
  insist(Object.entries(unchanged).every(([key, value]) => variables[key] === value)
    && same(JSON.parse(variables.AI_SERVICE_DISCLOSURES_JSON || 'null'), before.aiServiceDisclosures), 'CURRENT_FACTS_MISMATCH');
  return Object.freeze({ variables: Object.freeze({ ...variables, AI_SERVICE_DISCLOSURES_JSON: JSON.stringify(after.aiServiceDisclosures) }),
    summary: Object.freeze({ factsSha256: sha(afterBytes), changedVariables: ['AI_SERVICE_DISCLOSURES_JSON'], cloudOperationPerformed: false,
      requiresPublishedLegalHashVerification: true, requiresSeparateCandidateDeployment: true, runtimeVerified: false }) });
}

export function originalLegalRefreshScript(bundle, { inspectOnly = false } = {}) {
  validateOriginalLegalBundle(bundle);
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
test "$EUID" -eq 0
python3 - <<'ORIGINAL_LEGAL_PY'
import os,stat,pathlib,json,hashlib,gzip,base64,sys,signal,io
M=json.loads(${JSON.stringify(JSON.stringify(bundle.manifest))})
OLD=json.loads(${JSON.stringify(JSON.stringify(ORIGINAL_LEGAL_REVIEW))})
SHA='${bundle.sha256}'
INSPECT=${inspectOnly ? 'True' : 'False'}
INCOMING=pathlib.Path('${incoming}'); WORK=pathlib.Path('${remoteWork}')
SITE=pathlib.Path(M['site']); PUBLIC=pathlib.Path(M['directory']); SNIPPET=pathlib.Path(M['snippet'])
NAME='terms.html'
def sha(b): return hashlib.sha256(b).hexdigest()
def check(p,kind='dir',mode=None):
 s=p.lstat()
 assert not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
 assert (stat.S_ISDIR(s.st_mode) if kind=='dir' else stat.S_ISREG(s.st_mode) and s.st_nlink==1)
 if mode is not None: assert stat.S_IMODE(s.st_mode)==mode
 return s
def parents(p):
 for parent in reversed(p.parents): check(parent)
def read(p,limit=65536):
 parents(p); s=check(p,'file'); assert 0<s.st_size<=limit
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  opened=os.fstat(f.fileno()); assert (opened.st_dev,opened.st_ino)==(s.st_dev,s.st_ino)
  value=f.read(limit+1)
 assert len(value)==s.st_size
 return value
def sync_directory(p):
 fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(fd)
 finally: os.close(fd)
def create(p,data,mode):
 parents(p); fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
 os.chmod(p,mode); check(p,'file',mode); sync_directory(p.parent)
def matches(data,entry): return len(data)==entry['bytes'] and sha(data)==entry['sha256']
def current_pages():
 assert sha(read(SITE))==OLD['siteSha256']==M['siteSha256']
 assert sha(read(SNIPPET))==OLD['snippetSha256']==M['snippetSha256']
 parents(PUBLIC); check(PUBLIC,mode=0o755)
 assert set(os.listdir(PUBLIC))==set(OLD['files'])==set(M['files'])
 values={}
 for name in M['files']:
  check(PUBLIC/name,'file',0o644); values[name]=read(PUBLIC/name)
  if name!=NAME: assert matches(values[name],OLD['files'][name]) and OLD['files'][name]==M['files'][name]
 return values
def checked_backup():
 parents(WORK); check(WORK,mode=0o700)
 assert json.loads(read(WORK/'manifest.json'))==M
 assert json.loads(read(WORK/'baseline.json'))==OLD
 check(WORK/'terms.backup','file',0o600)
 assert matches(read(WORK/'terms.backup'),OLD['files'][NAME])
def replace_terms(staged,expected):
 values=current_pages(); assert matches(values[NAME],expected)
 check(staged,'file',0o644); assert PUBLIC.stat().st_dev==staged.stat().st_dev
 os.replace(staged,PUBLIC/NAME); sync_directory(PUBLIC)
def emit(code): print(code+' '+SHA,flush=True)
def interrupted(signum,frame): raise RuntimeError('interrupted')
signal.signal(signal.SIGTERM,interrupted)
work_owned=False; backup_ready=False
try:
 assert os.geteuid()==0
 values=current_pages(); all_old=matches(values[NAME],OLD['files'][NAME]); all_new=matches(values[NAME],M['files'][NAME])
 if INSPECT:
  if not os.path.lexists(WORK):
   assert all_old and sha(read(INCOMING,24000))==SHA; emit('ORIGINAL_LEGAL_UPLOADED')
  else:
   checked_backup()
   if all_new: emit('ORIGINAL_LEGAL_ACTIVE')
   elif all_old: emit('ORIGINAL_LEGAL_ROLLED_BACK')
   else: emit('ORIGINAL_LEGAL_UNCONFIRMED')
  sys.exit(0)
 assert all_old and not os.path.lexists(WORK)
 check(INCOMING,'file',0o600); raw=read(INCOMING,24000); assert sha(raw)==SHA
 with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed: decoded=compressed.read(393217)
 assert len(decoded)<=393216
 payload=json.loads(decoded); assert set(payload)=={'manifest','files'} and payload['manifest']==M and set(payload['files'])==set(M['files'])
 pages={}
 for name,entry in M['files'].items():
  f=payload['files'][name]; assert set(f)=={'bytes','sha256','content'}
  b=base64.b64decode(f['content'],validate=True)
  assert base64.b64encode(b).decode()==f['content'] and 0<len(b)<=65536
  assert matches(b,entry) and len(b)==f['bytes'] and sha(b)==f['sha256']; pages[name]=b
 assert sum(map(len,pages.values()))<=196608
 WORK.mkdir(mode=0o700); work_owned=True; check(WORK,mode=0o700); sync_directory(WORK.parent)
 create(WORK/'manifest.json',json.dumps(M,sort_keys=True).encode(),0o600)
 create(WORK/'baseline.json',json.dumps(OLD,sort_keys=True).encode(),0o600)
 create(WORK/'terms.backup',values[NAME],0o600); checked_backup(); backup_ready=True
 create(WORK/'terms.next',pages[NAME],0o644)
 assert matches(read(WORK/'terms.next'),M['files'][NAME])
 replace_terms(WORK/'terms.next',OLD['files'][NAME])
 assert matches(current_pages()[NAME],M['files'][NAME])
 create(WORK/'result.json',json.dumps({'state':'active','sha256':SHA}).encode(),0o600)
 emit('ORIGINAL_LEGAL_ACTIVE')
except BaseException as error:
 if isinstance(error,SystemExit) and error.code==0: raise
 if not INSPECT and work_owned and backup_ready:
  try:
   checked_backup(); value=current_pages()[NAME]
   assert matches(value,OLD['files'][NAME]) or matches(value,M['files'][NAME])
   if matches(value,M['files'][NAME]):
    create(WORK/'terms.restore',read(WORK/'terms.backup'),0o644)
    replace_terms(WORK/'terms.restore',M['files'][NAME])
   assert matches(current_pages()[NAME],OLD['files'][NAME]); emit('ORIGINAL_LEGAL_ROLLED_BACK')
  except BaseException: emit('ORIGINAL_LEGAL_UNCONFIRMED')
 else: emit('ORIGINAL_LEGAL_UNCONFIRMED')
 sys.exit(1)
ORIGINAL_LEGAL_PY
`;
}

const phases = ['prepared', 'upload_uncertain', 'upload_submitted', 'uploaded', 'refresh_uncertain', 'refresh_submitted', 'active', 'rolled_back'];
function checkedState(state, bundle) {
  insist(state && same(Object.keys(state).sort(), ['format', 'sha256', 'instanceId', 'baselineSha256', 'phase', 'uploadInvokeId', 'refreshInvokeId', 'inspectInvokeId'].sort())
    && state.format === 'original-effects-legal-operation-v1' && state.sha256 === bundle.sha256
    && state.instanceId === LEGAL_TARGET.instanceId && state.baselineSha256 === ORIGINAL_LEGAL_REVIEW.baselineBundleSha256
    && phases.includes(state.phase) && (state.uploadInvokeId === null || id(state.uploadInvokeId, 'f'))
    && ['refreshInvokeId', 'inspectInvokeId'].every(key => state[key] === null || id(state[key], 't')), 'JOURNAL_REJECTED');
  return state;
}
export function originalLegalJournal(bundle, { outputRoot = path.join(app, 'output/mini-original-effects-legal'), create = false } = {}) {
  validateOriginalLegalBundle(bundle);
  const directory = path.join(outputRoot, bundle.sha256), filename = path.join(directory, 'operation.json');
  if (create) {
    fs.mkdirSync(outputRoot, { recursive: true }); insist(fs.realpathSync(outputRoot) === path.resolve(outputRoot), 'JOURNAL_REJECTED');
    fs.mkdirSync(directory, { mode: 0o700 }); // exclusive: never merge with an earlier or partial operation
    const state = { format: 'original-effects-legal-operation-v1', sha256: bundle.sha256, instanceId: LEGAL_TARGET.instanceId,
      baselineSha256: ORIGINAL_LEGAL_REVIEW.baselineBundleSha256, phase: 'prepared', uploadInvokeId: null, refreshInvokeId: null, inspectInvokeId: null };
    fs.writeFileSync(path.join(directory, 'bundle.json.gz'), bundle.bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(filename, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  }
  insist(fs.realpathSync(directory) === path.resolve(directory), 'JOURNAL_REJECTED');
  insist(sha(regular(path.join(directory, 'bundle.json.gz'), 24000)) === bundle.sha256, 'JOURNAL_REJECTED');
  return {
    read() { return checkedState(JSON.parse(regular(filename, 4096)), bundle); },
    write(next, previous) {
      checkedState(next, bundle); insist(same(JSON.parse(regular(filename, 4096)), previous), 'JOURNAL_CHANGED');
      const temporary = filename + '.next', fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename); insist(same(JSON.parse(regular(filename, 4096)), next), 'JOURNAL_CHANGED');
    },
    claim(action) {
      insist(['upload', 'refresh', 'lock'].includes(action), 'ACTION_REJECTED');
      const marker = path.join(directory, action + '.started'), token = crypto.randomBytes(16).toString('hex');
      const fd = fs.openSync(marker, 'wx', 0o600);
      try { fs.writeFileSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return () => { insist(regular(marker).toString() === token, 'JOURNAL_CHANGED'); fs.unlinkSync(marker); };
    },
  };
}
export async function originalLegalAction(action, { bundle, journal, requestImpl }) {
  validateOriginalLegalBundle(bundle); insist(['upload', 'refresh', 'inspect', 'status'].includes(action), 'ACTION_REJECTED');
  let state = checkedState(journal.read(), bundle);
  const save = patch => { const next = { ...state, ...patch }; journal.write(next, state); state = next; };
  const run = async inspectOnly => requestImpl('RunCommand', { 'InstanceId.1': LEGAL_TARGET.instanceId, Type: 'RunShellScript',
    Name: `original-effects-legal-${inspectOnly ? 'inspect' : 'refresh'}`, CommandContent: Buffer.from(originalLegalRefreshScript(bundle, { inspectOnly })).toString('base64'),
    ContentEncoding: 'Base64', Timeout: '180', KeepCommand: 'false', Username: 'root' });
  if (action === 'upload') {
    insist(state.phase === 'prepared', 'NO_MUTATION_RETRY'); journal.claim('upload'); save({ phase: 'upload_uncertain' });
    const response = await requestImpl('SendFile', { 'InstanceId.1': LEGAL_TARGET.instanceId, Name: path.posix.basename(incoming), TargetDir: '/var/www',
      ContentType: 'Base64', Content: bundle.bytes.toString('base64'), FileOwner: 'root', FileGroup: 'root', FileMode: '0600', Overwrite: 'false', ClientToken: bundle.sha256 });
    insist(id(response.InvokeId, 'f'), 'UPLOAD_UNCONFIRMED'); save({ phase: 'upload_submitted', uploadInvokeId: response.InvokeId });
  } else if (action === 'refresh') {
    insist(state.phase === 'uploaded', 'UPLOAD_CONFIRMATION_REQUIRED'); journal.claim('refresh'); save({ phase: 'refresh_uncertain', inspectInvokeId: null });
    const response = await run(false); insist(id(response.InvokeId, 't'), 'REFRESH_UNCONFIRMED'); save({ phase: 'refresh_submitted', refreshInvokeId: response.InvokeId });
  } else if (action === 'inspect') {
    insist(state.phase !== 'prepared', 'NOT_UPLOADED');
    const response = await run(true); insist(id(response.InvokeId, 't'), 'INSPECT_UNCONFIRMED'); save({ inspectInvokeId: response.InvokeId });
  } else {
    const invocation = state.inspectInvokeId || (state.phase === 'upload_submitted' ? state.uploadInvokeId : state.refreshInvokeId);
    insist(invocation, 'INSPECT_REQUIRED');
    if (id(invocation, 'f')) {
      const response = await requestImpl('DescribeSendFileResults', { InvokeId: invocation, InstanceId: LEGAL_TARGET.instanceId, MaxResults: '1' });
      const records = response.Invocations?.Invocation; insist(Array.isArray(records) && records.length <= 1, 'STATUS_REJECTED');
      if (records.length) {
        const r = records[0], instances = r.InvokeInstances?.InvokeInstance;
        insist(r.InvokeId === invocation && r.Name === path.posix.basename(incoming) && r.TargetDir === '/var/www'
          && r.FileOwner === 'root' && r.FileGroup === 'root' && ['600', '0600'].includes(r.FileMode)
          && Array.isArray(instances) && instances.length === 1 && instances[0].InstanceId === LEGAL_TARGET.instanceId, 'STATUS_SCOPE_REJECTED');
        if (r.InvocationStatus === 'Success' && instances[0].InvocationStatus === 'Success' && !instances[0].ErrorCode && !instances[0].ErrorInfo) save({ phase: 'uploaded' });
      }
    } else {
      const response = await requestImpl('DescribeInvocationResults', { InvokeId: invocation, InstanceId: LEGAL_TARGET.instanceId, ContentEncoding: 'PlainText' });
      const results = response.Invocation?.InvocationResults?.InvocationResult; insist(Array.isArray(results) && results.length <= 1, 'STATUS_REJECTED');
      if (results.length) {
        const r = results[0]; insist(r.InstanceId === LEGAL_TARGET.instanceId && (!r.InvokeId || r.InvokeId === invocation), 'STATUS_SCOPE_REJECTED');
        const codes = String(r.Output || '').split(/\r?\n/).filter(line => /^ORIGINAL_LEGAL_(?:ACTIVE|UPLOADED|ROLLED_BACK|UNCONFIRMED) [a-f0-9]{64}$/.test(line));
        if (codes.length === 1 && codes[0].endsWith(` ${bundle.sha256}`) && r.InvocationStatus === 'Success' && r.ExitCode === 0) {
          if (codes[0].startsWith('ORIGINAL_LEGAL_ACTIVE ')) save({ phase: 'active' });
          else if (codes[0].startsWith('ORIGINAL_LEGAL_ROLLED_BACK ')) save({ phase: 'rolled_back' });
          else if (codes[0].startsWith('ORIGINAL_LEGAL_UPLOADED ') && ['upload_uncertain', 'upload_submitted'].includes(state.phase)) save({ phase: 'uploaded' });
        }
      }
    }
  }
  return { phase: state.phase, sha256: bundle.sha256, invocationId: state.inspectInvokeId || state.refreshInvokeId || state.uploadInvokeId,
    changesNodeOrDatabase: false, changesNginxConfiguration: false, reloadsNginx: false, backendFactsUpdated: false };
}
export function originalLegalPlan(bundle = buildOriginalLegalBundle()) {
  validateOriginalLegalBundle(bundle);
  return { action: 'plan', sha256: bundle.sha256, bytes: bundle.bytes.length, manifest: bundle.manifest, expectedOld: ORIGINAL_LEGAL_REVIEW,
    changedPages: ['terms.html'], readsCredentials: false, sendsRemoteCommand: false, changesNodeOrDatabase: false,
    changesNginxConfiguration: false, reloadsNginx: false, backendFactsUpdated: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), action = args[0] || 'plan';
    insist(['plan', 'prepare', 'upload', 'refresh', 'inspect', 'status'].includes(action), 'ACTION_REJECTED');
    const bundle = buildOriginalLegalBundle();
    if (action === 'plan') { insist(args.length <= 1, 'ARGUMENT_REJECTED'); console.log(JSON.stringify(originalLegalPlan(bundle))); }
    else {
      insist(args.length === 3 && args[1] === '--sha256' && digest(args[2]) && args[2] === bundle.sha256, 'REVIEWED_HASH_REQUIRED');
      const journal = originalLegalJournal(bundle, { create: action === 'prepare' });
      if (action === 'prepare') console.log(JSON.stringify({ phase: journal.read().phase, sha256: bundle.sha256, cloudOperationPerformed: false }));
      else {
        const unlock = journal.claim('lock');
        try { const { request } = await import('./inspect-app-ecs.mjs');
          console.log(JSON.stringify(await originalLegalAction(action, { bundle, journal, requestImpl: request })));
        } finally { unlock(); }
      }
    }
  } catch { console.error('ORIGINAL_LEGAL_OPERATION_UNCONFIRMED: inspect journal; never repeat upload or refresh after an uncertain request.'); process.exitCode = 1; }
}
