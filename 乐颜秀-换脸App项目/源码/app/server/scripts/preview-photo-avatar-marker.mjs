// Local layout check from the already completed v2 provider receipt. No model,
// moderation, OSS write, payment, activation or deployment call is made here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkedQwenPhotoResultUrl, createPhotoHttpsTransport } from '../photo-jobs/qwen-provider.js';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = 'natural-avatar-v2-20261013';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--preview-v2-label') throw Error();
  const destination = path.join(root, 'evidence/mini-photo-natural-avatar-v2-label-preview-20261013.png');
  if (fs.existsSync(destination)) throw Error();
  const sourceFile = path.join(root, `data/photo-avatar-generation-${version}/intent.jsonl`);
  const stat = fs.lstatSync(sourceFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
  const rows = fs.readFileSync(sourceFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const receipt = rows.filter(row => row.phase === 'generation_receipt');
  const report = rows.at(-1)?.report;
  if (rows.at(-1)?.phase !== 'probe_finished' || report?.passed !== true
    || report.probeVersion !== version || report.attemptedGenerationCalls !== 1 || receipt.length !== 1
    || report.acceptanceBinding?.specSha256 !== '5d4de1225b011792253dedda9730eda8fba9fc495e991dbd2f9c9119ad978bd9') throw Error();
  const url = checkedQwenPhotoResultUrl(receipt[0].receipt.url);
  const download = await createPhotoHttpsTransport()({ url: url.toString(), allowedHosts: [url.hostname],
    headers: { Accept: 'image/png' }, timeoutMs: 30000, maxBytes: 20 * 1024 * 1024 });
  if (download.status !== 200 || download.contentType !== 'image/png') throw Error();
  const bytes = download.bytes;
  const marker = createPhotoImageMarker({ serviceProviderCode: 'REDACTED_APP_IDENTIFIER', labelVersion: version });
  const marked = await marker.mark({ bytes, contentType: 'image/png', byteLength: bytes.length, sha256: hash(bytes),
    contentId: receipt[0].contentId, operation: 'edit', labelVersion: version });
  fs.writeFileSync(destination, marked.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ localPreviewOnly: true, source: 'completed-v2-provider-receipt',
    downloadedExistingOutput: true, generationCalls: 0, moderationCalls: 0, storageWrites: 0,
    finalPreviewModerationVerified: false, deployed: false, output: path.basename(destination),
    bytes: marked.byteLength, sha256: marked.sha256 }));
} catch {
  console.error('EXISTING_V2_LABEL_PREVIEW_UNCONFIRMED_NO_GENERATION_ATTEMPTED'); process.exitCode = 1;
}
