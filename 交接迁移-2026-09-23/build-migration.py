"""Create a PRIVATE local snapshot; includes secrets. Never uploads or changes source files."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import zipfile

handoff = Path(__file__).resolve().parent
root = handoff.parent
archive = root / '乐颜秀-私有迁移包-2026-09-23.zip'
if archive.exists():
    raise SystemExit('Archive already exists; refusing to overwrite it.')
skip_dirs = {'node_modules', '.pnpm-store', '.gradle', 'build', '.android-build-cache', '__pycache__'}
generated = {'文件清单.json', '打包报告.json', '校验结果.json', '迁移包.sha256'}
roots = [root / '乐颜秀-换脸App项目', root / 'dreamapi-image-proxy', handoff]
files = [root / 'AGENTS.md']
excluded = []
for tree in roots:
    for base, dirs, names in os.walk(tree):
        base = Path(base)
        kept = []
        for name in sorted(dirs):
            directory = base / name
            if name in skip_dirs or 'profile' in name.lower() or directory.is_symlink():
                excluded.append(directory.relative_to(root).as_posix())
            else:
                kept.append(name)
        dirs[:] = kept
        for name in sorted(names):
            file = base / name
            if file.is_symlink() or (base == handoff and name in generated):
                continue
            files.append(file)
# Preserve the exact current APK despite excluding other generated build directories.
apk = root / '乐颜秀-换脸App项目/源码/app/android/app/build/outputs/apk/debug/app-debug.apk'
if apk.exists():
    files.append(apk)
for name in ['_build_company_technical_package.py', '_build_payment_company_guide.py', '_render_payment_doc.ps1']:
    file = root / name
    if file.exists():
        files.append(file)
recovered = []
normalized = []
for file in sorted(set(files)):
    if not file.exists() and os.name == 'nt':
        # Historical Windows file with a trailing space: retain bytes under a portable name.
        extended = Path('\\\\?\\' + str(file))
        if not extended.is_file():
            raise FileNotFoundError(str(file))
        recovery_dir = handoff / '异常命名文件'
        recovery_dir.mkdir(exist_ok=True)
        saved = recovery_dir / (hashlib.sha256(str(file).encode('utf-8')).hexdigest()[:16] + '.bin')
        saved.write_bytes(extended.read_bytes())
        recovered.append({'original': file.relative_to(root).as_posix(), 'copied_as': saved.relative_to(root).as_posix(), 'reason': 'original filename cannot be read through normal Windows paths'})
        normalized.append(saved)
    else:
        normalized.append(file)
files = sorted(set(normalized))
entries = []
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=4, allowZip64=True) as bundle:
    for file in files:
        before = file.stat()
        relative = file.relative_to(root).as_posix()
        digest = hashlib.sha256()
        # Hash exactly the bytes written into the archive, without printing content.
        with file.open('rb') as source, bundle.open(relative, 'w', force_zip64=True) as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
                target.write(chunk)
        after = file.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError('Source changed during snapshot: ' + relative)
        entries.append({'path': relative, 'bytes': before.st_size, 'sha256': digest.hexdigest()})
    manifest = {'created': datetime.datetime.now().astimezone().isoformat(), 'files': entries}
    report = {
        'archive': archive.name,
        'privacy': 'PRIVATE, UNENCRYPTED: contains local environment credentials, data and evidence',
        'included_roots': [p.relative_to(root).as_posix() for p in roots],
        'file_count': len(entries),
        'uncompressed_bytes': sum(i['bytes'] for i in entries),
        'excluded_directories': excluded,
        'recovered_nonportable_filenames': recovered,
        'exception': apk.relative_to(root).as_posix(),
        'not_included': ['cloud OSS contents and cloud configuration', 'external signing keys and cloud login sessions', 'other workspace projects', 'external Codex skills'],
        'verification': 'Every payload file has a SHA-256 manifest; final archive verification is recorded separately.',
    }
    for name, value in [('文件清单.json', manifest), ('打包报告.json', report)]:
        path = handoff / name
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        bundle.write(path, path.relative_to(root).as_posix())
# Read every archived entry and compare against the manifest (also checks ZIP CRC).
with zipfile.ZipFile(archive) as bundle:
    for item in entries:
        digest = hashlib.sha256()
        with bundle.open(item['path']) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        if digest.hexdigest() != item['sha256']:
            raise RuntimeError('Archive hash mismatch: ' + item['path'])
    for name in ['文件清单.json', '打包报告.json']:
        assert bundle.read(handoff.name + '/' + name) == (handoff / name).read_bytes()
digest = hashlib.sha256()
with archive.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
(handoff / '迁移包.sha256').write_text(digest.hexdigest() + '  ' + archive.name + '\n', encoding='utf-8')
verification = {'archive': archive.name, 'bytes': archive.stat().st_size, 'sha256': digest.hexdigest(), 'verified_files': len(entries), 'zip_manifest_match': True, 'completed': datetime.datetime.now().astimezone().isoformat()}
(handoff / '校验结果.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(verification, ensure_ascii=True))
