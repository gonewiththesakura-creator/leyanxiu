// Local plan by default. Only upload/activate dispatch a mutation, once per journal.
// The credential-loading helper is imported only after an explicit remote action.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.dirname(SERVER);
export const LEGAL_TARGET = Object.freeze({
  instanceId: 'REDACTED_COMPANY_CLOUD_INSTANCE',
  site: '/etc/nginx/sites-available/leyanxiu-app-https.conf',
  originalSha256: '84bf97779f56e371071d1eed3a98cb3bfbf9d37b81a1ed7e1a9df56da9661d4d',
  directory: '/var/www/leyanxiu-mini-legal',
  snippet: '/etc/nginx/snippets/leyanxiu-mini-legal.conf',
});
export const LEGAL_PAGES = Object.freeze(['privacy.html', 'terms.html', 'third-parties.html']);
// One reviewed refresh only. Baseline comes from the 2026-10-12 HTTP evidence
// and the already installed, unchanged Nginx configuration and snippet.
export const LEGAL_REFRESH_BASELINE = Object.freeze({
  bundleSha256: '03dd297400a2a50dab4ef0947c668bb7b2bdf343bf63a5e173e0ce5c0ed7b2b1',
  siteSha256: '074b16ee9c06bf42c47664c1da7dcd76b3e97a6d587217961474b24d69fddab7',
  snippetSha256: '5ebe6b23c5e71ebfd21111a070b244bfc4c8d6dc334f2b69a70bfa58cf4a496c',
  files: {
    'privacy.html': { bytes: 12370, sha256: 'e079a99563fae84d00ab7d36d4d70d9e183474e2042af1916257e1fad85d6ba9' },
    'terms.html': { bytes: 11330, sha256: 'efbed56f9a6b3b0b0cdcd562ec22a361787fb44d7b4d5ab79aa7a6a59260322e' },
    'third-parties.html': { bytes: 8057, sha256: '95d6ebd0f9cbfaad44a0be869dfe1b6f9efad124369d268865080e1f6bf145f3' },
  },
});
export const LEGAL_REFRESH_TARGET_SHA256 = '628354a2f04d593b23f988410cc371d7a1171e7d04ce19c256fc7a471a34b226';
Object.values(LEGAL_REFRESH_BASELINE.files).forEach(Object.freeze);
Object.freeze(LEGAL_REFRESH_BASELINE.files);
const MAX_PAGE = 65536, MAX_CONTENT = 3 * MAX_PAGE, MAX_BUNDLE = 24000;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const insist = (ok, code) => { if (!ok) throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invokeId = value => typeof value === 'string' && /^t-[A-Za-z0-9]+$/.test(value);
const transferId = value => typeof value === 'string' && /^f-[A-Za-z0-9]+$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const report = value => console.log(JSON.stringify(value));

function regular(filename, maximum) {
  const stat = fs.lstatSync(filename);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum, 'MINI_LEGAL_FILE_REJECTED');
  const bytes = fs.readFileSync(filename);
  insist(bytes.length === stat.size, 'MINI_LEGAL_FILE_CHANGED');
  return bytes;
}
function noSymlinkTree(root, target) {
  const relative = path.relative(root, target);
  insist(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'MINI_LEGAL_PATH_REJECTED');
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    current = part ? path.join(current, part) : current;
    const stat = fs.lstatSync(current);
    insist(!stat.isSymbolicLink() && stat.isDirectory(), 'MINI_LEGAL_SYMLINK_REJECTED');
  }
}
export function legalSnippet() {
  return LEGAL_PAGES.map(name => `location = /mini/legal/${name} {
    alias ${LEGAL_TARGET.directory}/${name};
    default_type text/html;
    charset utf-8;
    autoindex off;
    disable_symlinks on;
    limit_except GET HEAD { deny all; }
    add_header X-Content-Type-Options "nosniff" always;
    add_header Cache-Control "no-cache" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
}
`).join('\n');
}
export function legalSiteConfiguration(original) {
  insist(hash(original) === LEGAL_TARGET.originalSha256, 'MINI_LEGAL_ORIGINAL_CONFIG_CHANGED');
  const text = original.toString('utf8');
  const anchor = '    # Request URLs can contain signed object tokens.';
  insist(text.split(anchor).length === 2 && !text.includes(LEGAL_TARGET.snippet), 'MINI_LEGAL_SITE_ANCHOR_REJECTED');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return Buffer.from(text.replace(anchor, `    include ${LEGAL_TARGET.snippet};${newline}${anchor}`));
}
export function buildLegalBundle({ appRoot = APP, nginxConfig = path.join(SERVER, 'deploy/nginx.app-account.conf.example') } = {}) {
  const directory = path.join(appRoot, 'public/mini/legal');
  noSymlinkTree(appRoot, directory);
  const files = {};
  for (const name of LEGAL_PAGES) {
    const bytes = regular(path.join(directory, name), MAX_PAGE);
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    insist(/<!doctype html>/i.test(html) && /<html(?:\s|>)/i.test(html) && /<\/html>\s*$/i.test(html)
      && !html.includes('\0') && !/<(?:script|iframe|object|embed|link)\b|\b(?:src|srcset)\s*=|@import\b|url\s*\(/i.test(html), 'MINI_LEGAL_HTML_REJECTED');
    files[name] = { bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('base64') };
  }
  const original = regular(nginxConfig, 65536);
  const manifest = { format: 'mini-legal-static-v1', ...LEGAL_TARGET,
    siteSha256: hash(legalSiteConfiguration(original)), snippetSha256: hash(Buffer.from(legalSnippet())),
    files: Object.fromEntries(LEGAL_PAGES.map(name => [name, { bytes: files[name].bytes, sha256: files[name].sha256 }])) };
  const payload = { manifest, files };
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const bundle = { bytes, sha256: hash(bytes), manifest };
  validateLegalBundle(bytes, bundle.sha256);
  return bundle;
}
export function validateLegalBundle(bytes, sha256) {
  insist(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_BUNDLE && digest(sha256) && hash(bytes) === sha256, 'MINI_LEGAL_BUNDLE_HASH_REJECTED');
  let payload;
  try { payload = JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: MAX_CONTENT * 2 }).toString('utf8')); }
  catch { throw new Error('MINI_LEGAL_BUNDLE_INVALID'); }
  insist(exactKeys(payload, ['manifest', 'files']) && exactKeys(payload.files, LEGAL_PAGES), 'MINI_LEGAL_BUNDLE_PATH_REJECTED');
  const m = payload.manifest;
  insist(exactKeys(m, ['format', ...Object.keys(LEGAL_TARGET), 'siteSha256', 'snippetSha256', 'files'])
    && m.format === 'mini-legal-static-v1' && Object.entries(LEGAL_TARGET).every(([key, value]) => m[key] === value)
    && digest(m.siteSha256) && m.snippetSha256 === hash(Buffer.from(legalSnippet())) && exactKeys(m.files, LEGAL_PAGES), 'MINI_LEGAL_BUNDLE_TARGET_REJECTED');
  let total = 0;
  for (const name of LEGAL_PAGES) {
    const file = payload.files[name], entry = m.files[name];
    insist(exactKeys(file, ['bytes', 'sha256', 'content']) && exactKeys(entry, ['bytes', 'sha256'])
      && typeof file.content === 'string', 'MINI_LEGAL_BUNDLE_INVALID');
    const content = Buffer.from(file.content, 'base64');
    insist(content.toString('base64') === file.content && content.length > 0 && content.length <= MAX_PAGE
      && file.bytes === content.length && entry.bytes === content.length && digest(file.sha256)
      && hash(content) === file.sha256 && entry.sha256 === file.sha256, 'MINI_LEGAL_PAGE_HASH_REJECTED');
    total += content.length;
  }
  insist(total <= MAX_CONTENT, 'MINI_LEGAL_BUNDLE_SIZE_REJECTED');
  return payload;
}

function remotePaths(bundle) {
  insist(digest(bundle.sha256), 'MINI_LEGAL_BUNDLE_HASH_REJECTED');
  return { incoming: `/var/www/.leyanxiu-mini-legal-${bundle.sha256}.json.gz`,
    work: `/var/www/.leyanxiu-mini-legal-${bundle.sha256}` };
}
// Python uses O_NOFOLLOW/exclusive creation and checks every ancestor before writes.
// No shell interpolation comes from HTML, the network, a journal, or user paths.
export function legalActivationScript(bundle, { inspectOnly = false } = {}) {
  validateLegalBundle(bundle.bytes, bundle.sha256);
  const m = bundle.manifest, remote = remotePaths(bundle);
  insist(JSON.stringify(validateLegalBundle(bundle.bytes, bundle.sha256).manifest) === JSON.stringify(m), 'MINI_LEGAL_MANIFEST_CHANGED');
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
test "$EUID" -eq 0
python3 - <<'MINI_LEGAL_PY'
import os,stat,pathlib,json,hashlib,gzip,base64,subprocess,sys,signal
M=json.loads(${JSON.stringify(JSON.stringify(m))})
SHA='${bundle.sha256}'
INSPECT=${inspectOnly ? 'True' : 'False'}
INCOMING=pathlib.Path('${remote.incoming}')
WORK=pathlib.Path('${remote.work}')
SITE=pathlib.Path(M['site']); PUBLIC=pathlib.Path(M['directory']); SNIPPET=pathlib.Path(M['snippet'])
SNIPPET_BYTES=base64.b64decode('${Buffer.from(legalSnippet()).toString('base64')}')
def sha(b): return hashlib.sha256(b).hexdigest()
def check(path,kind='dir',mode=None):
 s=path.lstat()
 assert not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022
 assert (stat.S_ISDIR(s.st_mode) if kind=='dir' else stat.S_ISREG(s.st_mode) and s.st_nlink==1)
 if mode is not None: assert stat.S_IMODE(s.st_mode)==mode
 return s
def parents(path):
 for p in reversed(path.parents): check(p)
def read(path,limit=393216):
 parents(path); s=check(path,'file'); assert 0<s.st_size<=limit
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  opened=os.fstat(f.fileno()); assert (opened.st_dev,opened.st_ino)==(s.st_dev,s.st_ino)
  value=f.read(limit+1)
 assert len(value)==s.st_size
 return value
def create(path,data,mode):
 parents(path)
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
 os.chmod(path,mode); check(path,'file',mode)
def replace_site(data,expected):
 assert sha(read(SITE))==expected
 temporary=SITE.with_name(SITE.name+'.mini-legal-'+SHA+'.tmp')
 create(temporary,data,0o644)
 assert sha(read(SITE))==expected
 os.replace(temporary,SITE)
 fd=os.open(SITE.parent,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(fd)
 finally: os.close(fd)
def run(args,label):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
 create(WORK/(label+'.log'),p.stdout or b'(no output)\\n',0o600)
 return p.returncode==0
def active_files():
 check(PUBLIC,mode=0o755); check(SNIPPET,'file',0o644)
 assert set(os.listdir(PUBLIC))==set(M['files'])
 assert sha(read(SITE))==M['siteSha256'] and sha(read(SNIPPET))==M['snippetSha256']
 for name,entry in M['files'].items():
  p=PUBLIC/name; check(p,'file',0o644); b=read(p,65536)
  assert len(b)==entry['bytes'] and sha(b)==entry['sha256']
def emit(code): print(code+' '+SHA,flush=True)
def interrupted(signum,frame): raise RuntimeError('interrupted')
signal.signal(signal.SIGTERM,interrupted)
swapped=False
work_owned=False
try:
 assert os.geteuid()==0
 for p in ['/var','/var/www','/etc','/etc/nginx','/etc/nginx/snippets','/etc/nginx/sites-available']:
  parents(pathlib.Path(p)); check(pathlib.Path(p))
 if INSPECT:
  current=sha(read(SITE))
  if current==M['siteSha256']:
   active_files()
   result=json.loads(read(WORK/'result.json'))
   assert result=={'state':'active','sha256':SHA,'siteSha256':M['siteSha256']}
   emit('MINI_LEGAL_ACTIVE')
  elif current==M['originalSha256']:
   if WORK.exists() and (WORK/'result.json').exists():
    result=json.loads(read(WORK/'result.json'))
    assert result=={'state':'rolled_back','sha256':SHA,'siteSha256':M['originalSha256']}
    emit('MINI_LEGAL_ROLLED_BACK')
   else:
    assert not os.path.lexists(PUBLIC) and not os.path.lexists(SNIPPET)
    assert sha(read(INCOMING,24000))==SHA
    emit('MINI_LEGAL_UPLOADED')
  else: raise ValueError('different configuration')
  sys.exit(0)
 original=read(SITE,65536)
 assert sha(original)==M['originalSha256']
 assert not os.path.lexists(PUBLIC) and not os.path.lexists(SNIPPET) and not os.path.lexists(WORK)
 check(INCOMING,'file',0o600); data=read(INCOMING,24000); assert sha(data)==SHA
 import io
 with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed: decoded=compressed.read(393217)
 assert len(decoded)<=393216
 payload=json.loads(decoded)
 assert set(payload)=={'manifest','files'} and payload['manifest']==M and set(payload['files'])==set(M['files'])
 pages={}
 for name,entry in M['files'].items():
  f=payload['files'][name]; assert set(f)=={'bytes','sha256','content'}
  b=base64.b64decode(f['content'],validate=True)
  assert base64.b64encode(b).decode()==f['content'] and 0<len(b)<=65536
  assert len(b)==entry['bytes']==f['bytes'] and sha(b)==entry['sha256']==f['sha256']
  pages[name]=b
 assert sum(len(b) for b in pages.values())<=196608
 assert sha(SNIPPET_BYTES)==M['snippetSha256']
 anchor=b'    # Request URLs can contain signed object tokens.'
 assert original.count(anchor)==1 and str(SNIPPET).encode() not in original
 newline=b'\\r\\n' if b'\\r\\n' in original else b'\\n'
 desired=original.replace(anchor,b'    include '+str(SNIPPET).encode()+b';'+newline+anchor,1)
 assert sha(desired)==M['siteSha256']
 WORK.mkdir(mode=0o700); work_owned=True; check(WORK,mode=0o700)
 create(WORK/'original.conf',original,0o600)
 create(WORK/'manifest.json',json.dumps(M,sort_keys=True).encode(),0o600)
 assert run(['nginx','-t'],'before-test')
 PUBLIC.mkdir(mode=0o755); os.chmod(PUBLIC,0o755); check(PUBLIC,mode=0o755)
 for name,b in pages.items(): create(PUBLIC/name,b,0o644)
 create(SNIPPET,SNIPPET_BYTES,0o644)
 replace_site(desired,M['originalSha256']); swapped=True
 assert run(['nginx','-t'],'candidate-test')
 assert run(['systemctl','reload','nginx'],'candidate-reload')
 active_files()
 create(WORK/'result.json',json.dumps({'state':'active','sha256':SHA,'siteSha256':M['siteSha256']}).encode(),0o600)
 emit('MINI_LEGAL_ACTIVE')
except BaseException as error:
 if isinstance(error,SystemExit) and error.code==0: raise
 if not INSPECT and work_owned and not swapped:
  try: swapped=sha(read(SITE))==M['siteSha256'] and WORK.is_dir()
  except BaseException: pass
 if swapped:
  try:
   backup=read(WORK/'original.conf',65536); assert sha(backup)==M['originalSha256']
   replace_site(backup,M['siteSha256'])
   assert sha(read(SITE))==M['originalSha256']
   assert run(['nginx','-t'],'rollback-test')
   assert run(['systemctl','reload','nginx'],'rollback-reload')
   create(WORK/'result.json',json.dumps({'state':'rolled_back','sha256':SHA,'siteSha256':M['originalSha256']}).encode(),0o600)
   emit('MINI_LEGAL_ROLLED_BACK')
  except BaseException: emit('MINI_LEGAL_ROLLBACK_UNCONFIRMED')
 else: emit('MINI_LEGAL_INSPECTION_UNCONFIRMED' if INSPECT else 'MINI_LEGAL_ACTIVATION_FAILED')
 sys.exit(1)
MINI_LEGAL_PY
`;
}

export function legalRefreshScript(bundle, { inspectOnly = false } = {}) {
  const payload = validateLegalBundle(bundle.bytes, bundle.sha256), m = bundle.manifest, remote = remotePaths(bundle);
  insist(bundle.sha256 === LEGAL_REFRESH_TARGET_SHA256 && JSON.stringify(payload.manifest) === JSON.stringify(m)
    && m.siteSha256 === LEGAL_REFRESH_BASELINE.siteSha256 && m.snippetSha256 === LEGAL_REFRESH_BASELINE.snippetSha256,
  'MINI_LEGAL_REFRESH_REVIEW_REJECTED');
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
test "$EUID" -eq 0
python3 - <<'MINI_LEGAL_PY'
import os,stat,pathlib,json,hashlib,gzip,base64,sys,signal,io
M=json.loads(${JSON.stringify(JSON.stringify(m))})
OLD=json.loads(${JSON.stringify(JSON.stringify(LEGAL_REFRESH_BASELINE))})
SHA='${bundle.sha256}'
INSPECT=${inspectOnly ? 'True' : 'False'}
INCOMING=pathlib.Path('${remote.incoming}')
WORK=pathlib.Path('${remote.work}-refresh')
SITE=pathlib.Path(M['site']); PUBLIC=pathlib.Path(M['directory']); SNIPPET=pathlib.Path(M['snippet'])
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
 parents(p)
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
 os.chmod(p,mode); check(p,'file',mode); sync_directory(p.parent)
def matches(data,entry): return len(data)==entry['bytes'] and sha(data)==entry['sha256']
def unchanged_config():
 assert sha(read(SITE))==OLD['siteSha256']==M['siteSha256']
 assert sha(read(SNIPPET))==OLD['snippetSha256']==M['snippetSha256']
def current_pages():
 unchanged_config(); parents(PUBLIC); check(PUBLIC,mode=0o755)
 assert set(os.listdir(PUBLIC))==set(OLD['files'])==set(M['files'])
 values={}
 for name in M['files']:
  check(PUBLIC/name,'file',0o644); values[name]=read(PUBLIC/name)
 return values
def checked_backups():
 parents(WORK); check(WORK,mode=0o700); check(WORK/'backup',mode=0o700)
 assert json.loads(read(WORK/'manifest.json'))==M
 assert json.loads(read(WORK/'baseline.json'))==OLD
 for name,entry in OLD['files'].items():
  check(WORK/'backup'/name,'file',0o600); assert matches(read(WORK/'backup'/name),entry)
def replace_page(name,staged,expected):
 unchanged_config(); assert matches(read(PUBLIC/name),expected)
 check(staged,'file',0o644)
 assert PUBLIC.stat().st_dev==staged.stat().st_dev
 os.replace(staged,PUBLIC/name); sync_directory(PUBLIC)
def emit(code): print(code+' '+SHA,flush=True)
def interrupted(signum,frame): raise RuntimeError('interrupted')
signal.signal(signal.SIGTERM,interrupted)
work_owned=False; backups_ready=False
try:
 assert os.geteuid()==0
 values=current_pages()
 all_old=all(matches(values[n],OLD['files'][n]) for n in M['files'])
 all_new=all(matches(values[n],M['files'][n]) for n in M['files'])
 if INSPECT:
  if not os.path.lexists(WORK):
   assert all_old and sha(read(INCOMING,24000))==SHA
   emit('MINI_LEGAL_UPLOADED')
  else:
   checked_backups()
   if all_new: emit('MINI_LEGAL_REFRESHED')
   elif all_old: emit('MINI_LEGAL_REFRESH_ROLLED_BACK')
   else: emit('MINI_LEGAL_REFRESH_PARTIAL')
  sys.exit(0)
 assert all_old and not os.path.lexists(WORK)
 check(INCOMING,'file',0o600); data=read(INCOMING,24000); assert sha(data)==SHA
 with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed: decoded=compressed.read(393217)
 assert len(decoded)<=393216
 payload=json.loads(decoded)
 assert set(payload)=={'manifest','files'} and payload['manifest']==M and set(payload['files'])==set(M['files'])
 pages={}
 for name,entry in M['files'].items():
  f=payload['files'][name]; assert set(f)=={'bytes','sha256','content'}
  b=base64.b64decode(f['content'],validate=True)
  assert base64.b64encode(b).decode()==f['content'] and 0<len(b)<=65536
  assert matches(b,entry) and len(b)==f['bytes'] and sha(b)==f['sha256']
  pages[name]=b
 assert sum(map(len,pages.values()))<=196608
 WORK.mkdir(mode=0o700); work_owned=True; check(WORK,mode=0o700); sync_directory(WORK.parent)
 (WORK/'backup').mkdir(mode=0o700); check(WORK/'backup',mode=0o700)
 (WORK/'next').mkdir(mode=0o700); check(WORK/'next',mode=0o700)
 create(WORK/'manifest.json',json.dumps(M,sort_keys=True).encode(),0o600)
 create(WORK/'baseline.json',json.dumps(OLD,sort_keys=True).encode(),0o600)
 for name,b in values.items(): create(WORK/'backup'/name,b,0o600)
 checked_backups(); backups_ready=True
 for name,b in pages.items(): create(WORK/'next'/name,b,0o644)
 values=current_pages(); assert all(matches(values[n],OLD['files'][n]) for n in M['files'])
 for name in M['files']:
  assert matches(read(WORK/'next'/name),M['files'][name])
  replace_page(name,WORK/'next'/name,OLD['files'][name])
 values=current_pages(); assert all(matches(values[n],M['files'][n]) for n in M['files'])
 create(WORK/'result.json',json.dumps({'state':'refreshed','sha256':SHA}).encode(),0o600)
 emit('MINI_LEGAL_REFRESHED')
except BaseException as error:
 if isinstance(error,SystemExit) and error.code==0: raise
 if not INSPECT and work_owned and backups_ready:
  try:
   checked_backups(); values=current_pages()
   assert all(matches(values[n],OLD['files'][n]) or matches(values[n],M['files'][n]) for n in M['files'])
   for name in M['files']:
    if matches(values[name],M['files'][name]):
     restored=WORK/(name+'.restore'); create(restored,read(WORK/'backup'/name),0o644)
     replace_page(name,restored,M['files'][name])
   values=current_pages(); assert all(matches(values[n],OLD['files'][n]) for n in M['files'])
   emit('MINI_LEGAL_REFRESH_ROLLED_BACK')
  except BaseException: emit('MINI_LEGAL_REFRESH_PARTIAL')
 else: emit('MINI_LEGAL_INSPECTION_UNCONFIRMED' if INSPECT else 'MINI_LEGAL_REFRESH_FAILED')
 sys.exit(1)
MINI_LEGAL_PY
`;
}

export function createLegalJournal(bundle, outputRoot = path.join(APP, 'output/mini-legal-static'), { mode = 'install' } = {}) {
  validateLegalBundle(bundle.bytes, bundle.sha256);
  insist(['install', 'refresh'].includes(mode), 'MINI_LEGAL_ACTION_REJECTED');
  if (mode === 'refresh') legalRefreshScript(bundle);
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  insist(!fs.lstatSync(outputRoot).isSymbolicLink(), 'MINI_LEGAL_JOURNAL_REJECTED');
  const directory = path.join(outputRoot, bundle.sha256);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  noSymlinkTree(outputRoot, directory);
  const filename = path.join(directory, 'operation.json');
  const initial = { format: 'mini-legal-operation-v1', sha256: bundle.sha256, instanceId: LEGAL_TARGET.instanceId, phase: 'planned', uploadInvokeId: null, activateInvokeId: null, inspectInvokeId: null,
    ...(mode === 'refresh' ? { operationMode: 'refresh', baselineSha256: hash(Buffer.from(JSON.stringify(LEGAL_REFRESH_BASELINE))) } : {}) };
  if (!fs.existsSync(filename)) {
    fs.writeFileSync(path.join(directory, 'bundle.json.gz'), bundle.bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(filename, JSON.stringify(initial), { flag: 'wx', mode: 0o600 });
  }
  validateLegalBundle(regular(path.join(directory, 'bundle.json.gz'), MAX_BUNDLE), bundle.sha256);
  return {
    claim(action) {
      insist(['upload','activate','refresh'].includes(action), 'MINI_LEGAL_ACTION_REJECTED');
      const fd = fs.openSync(path.join(directory, `${action}.started`), 'wx', 0o600);
      try { fs.writeFileSync(fd, bundle.sha256); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
    read() {
      const value = JSON.parse(regular(filename, 4096));
      insist(exactKeys(value, Object.keys(initial)) && value.format === initial.format && value.sha256 === initial.sha256
        && value.instanceId === initial.instanceId && ['planned','upload_uncertain','upload_submitted','uploaded','activate_uncertain','activate_submitted','active','rolled_back','refresh_partial'].includes(value.phase)
        && (mode !== 'refresh' || (value.operationMode === initial.operationMode && value.baselineSha256 === initial.baselineSha256))
        && (value.uploadInvokeId === null || transferId(value.uploadInvokeId))
        && ['activateInvokeId','inspectInvokeId'].every(key => value[key] === null || invokeId(value[key])), 'MINI_LEGAL_JOURNAL_REJECTED');
      return value;
    },
    write(value) {
      const fd = fs.openSync(filename + '.next', 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(filename + '.next', filename);
    },
  };
}
export async function deployLegalAction(action, { bundle, journal, requestImpl }) {
  validateLegalBundle(bundle.bytes, bundle.sha256);
  insist(['upload','activate','refresh','status'].includes(action), 'MINI_LEGAL_ACTION_REJECTED');
  const state = journal.read();
  insist(state.sha256 === bundle.sha256 && state.instanceId === LEGAL_TARGET.instanceId, 'MINI_LEGAL_JOURNAL_REJECTED');
  const refresh = state.operationMode === 'refresh';
  insist(action !== 'refresh' || refresh, 'MINI_LEGAL_REFRESH_JOURNAL_REQUIRED');
  insist(action !== 'activate' || !refresh, 'MINI_LEGAL_INSTALL_JOURNAL_REQUIRED');
  if (refresh) legalRefreshScript(bundle);
  const parameters = { 'InstanceId.1': LEGAL_TARGET.instanceId };
  const run = async inspect => requestImpl('RunCommand', { ...parameters, Type: 'RunShellScript',
    Name: `mini-legal-${inspect ? 'inspect' : refresh ? 'refresh' : 'activate'}-${bundle.sha256.slice(0,16)}`,
    CommandContent: Buffer.from((refresh ? legalRefreshScript : legalActivationScript)(bundle, { inspectOnly: inspect })).toString('base64'),
    ContentEncoding: 'Base64', Timeout: '180', KeepCommand: 'false', Username: 'root' });
  if (action === 'upload') {
    insist(state.phase === 'planned', 'MINI_LEGAL_NO_MUTATION_RETRY');
    journal.claim('upload');
    state.phase = 'upload_uncertain'; journal.write(state);
    const response = await requestImpl('SendFile', { ...parameters, Name: path.posix.basename(remotePaths(bundle).incoming),
      TargetDir: '/var/www', ContentType: 'Base64', Content: bundle.bytes.toString('base64'),
      FileOwner: 'root', FileGroup: 'root', FileMode: '0600', Overwrite: 'false', ClientToken: bundle.sha256 });
    insist(transferId(response.InvokeId), 'MINI_LEGAL_TRANSFER_UNCONFIRMED');
    state.uploadInvokeId = response.InvokeId; state.phase = 'upload_submitted'; journal.write(state);
  } else if (action === 'activate' || action === 'refresh') {
    insist(state.phase === 'uploaded', 'MINI_LEGAL_UPLOAD_CONFIRMATION_REQUIRED');
    journal.claim(action);
    state.phase = 'activate_uncertain'; state.inspectInvokeId = null; journal.write(state);
    const response = await run(false);
    insist(invokeId(response.InvokeId), 'MINI_LEGAL_ACTIVATION_UNCONFIRMED');
    state.activateInvokeId = response.InvokeId; state.phase = 'activate_submitted'; journal.write(state);
  } else {
    const id = state.inspectInvokeId || (state.phase === 'upload_submitted' ? state.uploadInvokeId
      : refresh && ['upload_uncertain','activate_uncertain'].includes(state.phase) ? null : state.activateInvokeId);
    if (!id) {
      insist(state.phase !== 'planned', 'MINI_LEGAL_NOT_UPLOADED');
      const response = await run(true);
      insist(invokeId(response.InvokeId), 'MINI_LEGAL_INSPECTION_UNCONFIRMED');
      state.inspectInvokeId = response.InvokeId; journal.write(state);
    } else {
      if (id === state.uploadInvokeId) {
        const response = await requestImpl('DescribeSendFileResults', { InvokeId: id, InstanceId: LEGAL_TARGET.instanceId, MaxResults: '1' });
        const records = response.Invocations?.Invocation;
        insist(Array.isArray(records) && records.length <= 1, 'MINI_LEGAL_STATUS_UNCONFIRMED');
        if (!records.length) return { phase: state.phase, status: 'Pending', sha256: bundle.sha256 };
        const record = records[0], instances = record.InvokeInstances?.InvokeInstance;
        insist(record.InvokeId === id && record.Name === path.posix.basename(remotePaths(bundle).incoming)
          && record.TargetDir === '/var/www' && record.FileOwner === 'root' && record.FileGroup === 'root'
          && ['600','0600'].includes(record.FileMode) && Array.isArray(instances) && instances.length === 1
          && instances[0].InstanceId === LEGAL_TARGET.instanceId, 'MINI_LEGAL_STATUS_SCOPE_REJECTED');
        const status = ['Pending','Running','Success','Failed','Timeout','Aborted','Invalid','Error'].includes(instances[0].InvocationStatus)
          ? instances[0].InvocationStatus : 'Unknown';
        if (status === 'Success' && record.InvocationStatus === 'Success' && !instances[0].ErrorCode && !instances[0].ErrorInfo) {
          state.phase = 'uploaded'; journal.write(state);
        }
        return { phase: state.phase, status, sha256: bundle.sha256 };
      }
      const response = await requestImpl('DescribeInvocationResults', { InvokeId: id, InstanceId: LEGAL_TARGET.instanceId, ContentEncoding: 'PlainText' });
      const results = response.Invocation?.InvocationResults?.InvocationResult;
      insist(Array.isArray(results) && results.length <= 1, 'MINI_LEGAL_STATUS_UNCONFIRMED');
      const result = results[0];
      if (!result) return { phase: state.phase, status: 'Pending', sha256: bundle.sha256 };
      insist(result.InstanceId === LEGAL_TARGET.instanceId && (!result.InvokeId || result.InvokeId === id), 'MINI_LEGAL_STATUS_SCOPE_REJECTED');
      const status = ['Pending','Running','Success','Failed','Timeout','Aborted','Cancelled'].includes(result.InvocationStatus) ? result.InvocationStatus : 'Unknown';
      const codes = String(result.Output || '').split(/\r?\n/).filter(line => /^(?:MINI_LEGAL_ACTIVE|MINI_LEGAL_UPLOADED|MINI_LEGAL_ROLLED_BACK|MINI_LEGAL_ROLLBACK_UNCONFIRMED|MINI_LEGAL_ACTIVATION_FAILED|MINI_LEGAL_INSPECTION_UNCONFIRMED|MINI_LEGAL_REFRESHED|MINI_LEGAL_REFRESH_ROLLED_BACK|MINI_LEGAL_REFRESH_PARTIAL|MINI_LEGAL_REFRESH_FAILED) [a-f0-9]{64}$/.test(line))
        .filter(line => line.endsWith(` ${bundle.sha256}`)).map(line => line.split(' ')[0]);
      if (status === 'Success' && result.ExitCode === 0) {
        if (codes.length === 1 && codes[0] === (refresh ? 'MINI_LEGAL_REFRESHED' : 'MINI_LEGAL_ACTIVE')) state.phase = 'active';
        else if (codes.length === 1 && codes[0] === 'MINI_LEGAL_UPLOADED' && state.phase === 'upload_uncertain') state.phase = 'uploaded';
        else if (codes.length === 1 && codes[0] === 'MINI_LEGAL_ROLLED_BACK' && !refresh) state.phase = 'rolled_back';
      } else if (codes.length === 1 && codes[0] === 'MINI_LEGAL_ROLLED_BACK' && !refresh) state.phase = 'rolled_back';
      if (refresh) {
        if (codes.length === 1 && codes[0] === 'MINI_LEGAL_REFRESH_ROLLED_BACK') state.phase = 'rolled_back';
        else if (codes.length === 1 && codes[0] === 'MINI_LEGAL_REFRESH_PARTIAL') state.phase = 'refresh_partial';
        else if (['Failed','Timeout','Aborted','Cancelled'].includes(status)) {
          state.phase = 'activate_uncertain'; state.inspectInvokeId = null;
        }
      }
      journal.write(state);
      return { phase: state.phase, status, codes, sha256: bundle.sha256 };
    }
  }
  return { phase: state.phase, sha256: bundle.sha256, invocationId: state.inspectInvokeId || state.activateInvokeId || state.uploadInvokeId };
}
async function main(args) {
  const requested = args[0] || 'plan', refresh = requested.startsWith('refresh');
  const action = ({ 'refresh-plan': 'plan', 'refresh-upload': 'upload', 'refresh-status': 'status' })[requested] || requested;
  insist(['plan','upload','activate','status','refresh'].includes(action), 'MINI_LEGAL_ACTION_REJECTED');
  const outputRoot = path.join(APP, refresh ? 'output/mini-legal-refresh' : 'output/mini-legal-static');
  let bundle;
  if (action === 'status') {
    insist(args.length === 3 && args[1] === '--sha256' && digest(args[2]), 'MINI_LEGAL_REVIEWED_HASH_REQUIRED');
    noSymlinkTree(outputRoot, path.join(outputRoot, args[2]));
    const bytes = regular(path.join(outputRoot, args[2], 'bundle.json.gz'), MAX_BUNDLE);
    bundle = { bytes, sha256: args[2], manifest: validateLegalBundle(bytes, args[2]).manifest };
  } else bundle = buildLegalBundle();
  if (refresh) legalRefreshScript(bundle);
  if (action === 'plan') {
    insist(args.length <= 1, 'MINI_LEGAL_ARGUMENTS_REJECTED');
    report({ code: refresh ? 'MINI_LEGAL_REFRESH_LOCAL_PLAN' : 'MINI_LEGAL_LOCAL_PLAN', sha256: bundle.sha256, bytes: bundle.bytes.length, manifest: bundle.manifest,
      ...(refresh ? { expectedOld: LEGAL_REFRESH_BASELINE, changesNginxConfiguration: false, reloadsNginx: false } : {}),
      readsCredentials: false, sendsRemoteCommand: false, changesNodeOrDatabase: false });
    return;
  }
  insist(args.length === 3 && args[1] === '--sha256' && args[2] === bundle.sha256, 'MINI_LEGAL_REVIEWED_HASH_REQUIRED');
  const journal = createLegalJournal(bundle, outputRoot, { mode: refresh ? 'refresh' : 'install' });
  const { request } = await import('./inspect-app-ecs.mjs');
  report(await deployLegalAction(action, { bundle, journal, requestImpl: request }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => {
  report({ error: 'MINI_LEGAL_OPERATION_UNCONFIRMED', next: 'Inspect the local journal and run status (refresh-status for a refresh); do not repeat upload, activate or refresh.' });
  process.exitCode = 1;
});
