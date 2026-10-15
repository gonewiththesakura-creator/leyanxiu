import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeImageDataUrl } from '../media-validation.js';
import { parsePhotoUpload } from './upload-repository.js';

const script = fileURLToPath(new URL('../normalize-photo-input.py', import.meta.url));
const MAX = 2 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const invalid = 'PHOTO_UPLOAD_INVALID_REQUEST';
const unavailable = 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE';

/** Server-owned port. One child at a time and at most three queued inputs; the
 * deadline includes queue time. No files, provider calls or inherited secrets. */
export function createPhotoInputNormalizer({
  python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
  timeoutMs = 10_000, spawnProcess = spawn,
} = {}) {
  if (typeof python !== 'string' || !python || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000
    || typeof spawnProcess !== 'function') throw fail('PHOTO_UPLOAD_PREPROCESS_CONFIG_INVALID');
  let active = false;
  const queue = [];
  const next = () => { if (!active && queue.length) { active = true; queue.shift()(); } };
  return {
    async normalize(image) {
      // Admission precedes base64 decoding/copying. A saturated process does
      // not allocate more input buffers while the single Pillow child runs.
      if (Number(active) + queue.length >= 4) throw fail(unavailable);
      const input = parsePhotoUpload(image);
      const bytes = input.bytes;
      try { decodeImageDataUrl(`data:${input.contentType};base64,${bytes.toString('base64')}`,
        { maxBytes: MAX, maxSide: 8192, maxPixels: 40_000_000 }); } catch { throw fail(invalid); }
      const output = await new Promise((resolve, reject) => {
        let child, failure, size = 0, stderrSize = 0, ended = false, started = false;
        const chunks = [];
        const close = code => {
          if (ended) return;
          ended = true; clearTimeout(timer);
          if (started) { active = false; next(); }
          if (failure || code !== 0 || size < 16) reject(fail(failure || (code === 2 ? invalid : unavailable)));
          else resolve(Buffer.concat(chunks, size));
        };
        const abort = code => {
          if (ended || failure) return;
          failure = code;
          if (child) child.kill('SIGKILL');
          else { const index = queue.indexOf(start); if (index !== -1) queue.splice(index, 1); close(1); }
        };
        const start = () => {
          started = true;
          try {
            const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
              .filter(name => process.env[name]).map(name => [name, process.env[name]]));
            env.PYTHONIOENCODING = 'utf-8';
            child = spawnProcess(python, [script, '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            child.once('error', () => abort(unavailable));
            child.once('close', close);
            child.stdin.on('error', () => abort(unavailable));
            child.stdout.on('error', () => abort(unavailable));
            child.stderr.on('error', () => abort(unavailable));
            child.stdout.on('data', chunk => { if (failure || ended) return; size += chunk.length;
              if (size > MAX) abort(invalid); else chunks.push(Buffer.from(chunk)); });
            child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 4096) abort(unavailable); });
            child.stdin.end(bytes);
          } catch { abort(unavailable); }
        };
        const timer = setTimeout(() => abort(unavailable), timeoutMs);
        queue.push(start); next();
      });
      const contentType = output[0] === 0xff && output[1] === 0xd8 ? 'image/jpeg' : 'image/png';
      try { decodeImageDataUrl(`data:${contentType};base64,${output.toString('base64')}`,
        { maxBytes: MAX, maxSide: 8192, maxPixels: 40_000_000 }); } catch { throw fail(unavailable); }
      return { bytes: output, byteLength: output.length, sha256: hash(output), contentType };
    },
  };
}
