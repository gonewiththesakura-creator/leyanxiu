import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeImageDataUrl } from '../media-validation.js';

const script = fileURLToPath(new URL('../mark-ai.py', import.meta.url));
const MAX = 20 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  && !['unconfigured', 'unknown', 'none'].includes(value.toLowerCase());

/** Reuses the actual Pillow/XMP marker through pipes, without writing images to
 * temporary files. Verified here means this writer completed and re-read its
 * own payload, not a formal conformance report or third-party certification. */
export function createPhotoImageMarker({ serviceProviderCode, labelVersion,
  python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3'),
  font, timeoutMs = 30_000, spawnProcess = spawn } = {}) {
  if (!identifier(serviceProviderCode) || !identifier(labelVersion) || typeof python !== 'string' || !python
    || (font !== undefined && (typeof font !== 'string' || !font)) || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 10 || timeoutMs > 30_000 || typeof spawnProcess !== 'function') throw fail('PHOTO_MARKER_CONFIG_REQUIRED');
  return {
    async mark(input) {
      const bytes = Buffer.isBuffer(input?.bytes) ? Buffer.from(input.bytes) : null;
      const contentId = input?.contentId, operation = input?.operation;
      if (!bytes || bytes.length > MAX || input?.contentType !== 'image/png' || input.byteLength !== bytes.length
        || input.sha256 !== sha(bytes) || input.labelVersion !== labelVersion || !identifier(contentId)
        || !['generate', 'edit'].includes(operation)) throw fail('PHOTO_MARKER_INPUT_INVALID');
      try { decodeImageDataUrl(`data:image/png;base64,${bytes.toString('base64')}`,
        { maxBytes: MAX, maxSide: 2048, maxPixels: 2048 * 2048 }); }
      catch { throw fail('PHOTO_MARKER_INPUT_INVALID'); }
      const marked = await new Promise((resolve, reject) => {
        let child, timer, done = false, size = 0, stderrSize = 0; const chunks = [];
        const finish = (error, result) => {
          if (done) return;
          done = true; clearTimeout(timer);
          if (error) { child?.kill(); reject(fail(error)); } else resolve(result);
        };
        try {
          // Credentials and unrelated provider settings never enter this child.
          const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
            .filter(name => process.env[name]).map(name => [name, process.env[name]]));
          env.PYTHONIOENCODING = 'utf-8';
          if (font) env.AI_MARK_FONT = font;
          child = spawnProcess(python, [script, '--stdio', '--content-id', contentId,
            '--service-provider', serviceProviderCode, '--operation', operation], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          timer = setTimeout(() => finish('PHOTO_MARKER_TIMEOUT'), timeoutMs);
          child.on('error', () => finish('PHOTO_MARKER_UNCONFIRMED'));
          child.stdin.on('error', () => finish('PHOTO_MARKER_UNCONFIRMED'));
          child.stdout.on('error', () => finish('PHOTO_MARKER_UNCONFIRMED'));
          child.stdout.on('data', chunk => { if (done) return; const value = Buffer.from(chunk); size += value.length;
            if (size > MAX) finish('PHOTO_MARKER_OUTPUT_TOO_LARGE'); else chunks.push(value); });
          child.stderr.on('data', chunk => { stderrSize += chunk.length; if (stderrSize > 64 * 1024) finish('PHOTO_MARKER_UNCONFIRMED'); });
          child.on('close', code => { if (code !== 0 || size < 45) finish('PHOTO_MARKER_UNCONFIRMED');
            else finish(null, Buffer.concat(chunks, size)); });
          child.stdin.end(bytes);
        } catch { finish('PHOTO_MARKER_UNCONFIRMED'); }
      });
      try { decodeImageDataUrl(`data:image/png;base64,${marked.toString('base64')}`,
        { maxBytes: MAX, maxSide: 2048, maxPixels: 2048 * 2048 }); }
      catch { throw fail('PHOTO_MARKER_OUTPUT_UNCONFIRMED'); }
      return { bytes: marked, byteLength: marked.length, sha256: sha(marked), contentType: 'image/png',
        verified: true, conformanceVerified: false, contentId, operation, labelVersion };
    },
  };
}
