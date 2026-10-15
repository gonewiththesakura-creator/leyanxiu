"""Read-only verification of extracted migration files. Python 3, standard library only."""
from pathlib import Path
import hashlib
import json
import sys

handoff = Path(__file__).resolve().parent
root = handoff.parent
manifest = json.loads((handoff / '文件清单.json').read_text(encoding='utf-8'))
errors = []
for item in manifest['files']:
    file = (root / item['path']).resolve()
    if not file.is_relative_to(root):
        errors.append({'path': item['path'], 'reason': 'unsafe path'})
        continue
    if not file.is_file():
        errors.append({'path': item['path'], 'reason': 'missing'})
        continue
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if file.stat().st_size != item['bytes'] or digest.hexdigest() != item['sha256']:
        errors.append({'path': item['path'], 'reason': 'content mismatch'})
print(json.dumps({'checked': len(manifest['files']), 'failures': errors}, ensure_ascii=True, indent=2))
sys.exit(1 if errors else 0)
