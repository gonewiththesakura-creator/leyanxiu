import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import debug from 'debug';
import { createPhotoImageModerator, createGreenImageTransport, createOssModerationStorage } from '../photo-jobs/moderation.js';
import { privateJournal } from './verify-photo-private-storage.mjs';

// PREPARED ONLY: paid calls require separately approved --execute. Never used by
// application startup, sales, workers or release readiness. No automatic retry.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = 'synthetic-probe-v1';
// Pillow-generated and verify()-decoded 256x256 solid colour PNG; no people,
// original user media, text, metadata, EXIF or remote image source.
export const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAACwElEQVR4nO3TQQEAEADAQPTRRRzxxfDYXYJ9Nve5A6rW7wD4yQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBSDMAaQYgzQCkGYA0A5BmANIMQJoBGGUPTCcC9ajTJUAAAAAASUVORK5CYII=', 'base64');
const sha256 = crypto.createHash('sha256').update(syntheticPng).digest('hex');
const services = Object.freeze({ input: 'baselineCheck', output: 'aigcCheck' });

export async function runSyntheticProbe({ region, transport, storage, journal, timeoutMs = 12_000 }) {
  if (typeof journal !== 'function' || typeof transport !== 'function') throw new Error('PROBE_PORTS_REQUIRED');
  const report = { executed: true, syntheticOnly: true, productionApproved: false, maximumGreenCalls: 2,
    attemptedGreenCalls: 0, results: [], passed: false };
  const used = new Set();
  let currentDirection;
  const record = async entry => {
    if (await journal(entry) !== true) throw new Error('PROBE_JOURNAL_UNCONFIRMED');
  };
  const moderator = createPhotoImageModerator({
    policy: { approved: true, version, region, services, lowRisk: 'review', timeoutMs, maxBytes: 1024 * 1024 }, storage,
    transport: async request => {
      if (request.service !== services[currentDirection] || used.has(request.service) || used.size >= 2) throw new Error('PROBE_CALL_LIMIT');
      used.add(request.service);
      // A commit/timeout failure here must not submit the potentially billable API.
      await record({ phase: 'provider_attempt_intent', direction: currentDirection, service: request.service, sha256 });
      report.attemptedGreenCalls += 1;
      return transport(request); // Installed official SDK is configured no-retry.
    },
  });
  await record({ phase: 'probe_started', policyVersion: version, sha256, maxGreenCalls: 2 });
  const audit = async direction => {
    currentDirection = direction;
    try {
      const receipt = await moderator.moderate({ bytes: syntheticPng, contentType: 'image/png', direction,
        journal: async intent => {
          await record({ phase: 'scratch_intent', direction, key: `private/photo-moderation/${intent.reference}.${intent.extension}`,
            sha256, reference: intent.reference, extension: intent.extension });
          return true;
        },
      });
      // Full module-whitelisted receipt remains in the protected journal only.
      await record({ phase: 'receipt', direction, receipt });
      const bound = receipt.sha256 === sha256 && receipt.direction === direction && receipt.service === services[direction]
        && receipt.policyVersion === version && typeof receipt.reference === 'string' && receipt.reference.startsWith('mod_');
      const summary = { direction, service: services[direction], decision: receipt.decision,
        receiptBound: bound, requestIdPresent: typeof receipt.requestId === 'string' && !!receipt.requestId,
        cleanupPending: receipt.cleanupPending === true };
      report.results.push(summary);
      return summary.decision === 'allow' && bound && !summary.cleanupPending;
    } catch {
      report.results.push({ direction, service: services[direction], decision: 'unconfirmed', journalUnconfirmed: true });
      return false;
    }
  };
  // Deliberately two explicit calls; an unknown first outcome does not trigger a
  // second call or repeat. No polling, fallback, purchase or service activation.
  const inputPassed = await audit('input');
  if (inputPassed) report.passed = await audit('output');
  await record({ phase: 'probe_finished', report });
  return report;
}

async function execute() {
  debug.disable();
  const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  const required = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'];
  if (!required.every(key => typeof env[key] === 'string' && env[key].trim())) throw new Error('EXPECTED_CONFIGURATION_INCOMPLETE');
  const region = env.OSS_REGION.replace(/^oss-/, '');
  if (env.OSS_REGION !== `oss-${region}`) throw new Error('EXPECTED_REGION_INVALID');
  const credential = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET };
  const transport = createGreenImageTransport({ credential, region });
  const storage = createOssModerationStorage({ credential, bucket: env.OSS_BUCKET, region });
  // The exclusive fixed directory intentionally survives completion/failure.
  // Rerunning cannot silently start another paid probe, even after process death.
  const append = privateJournal(version, { prefix: 'photo-green', createdBy: 'synthetic-green-probe' });
  return runSyntheticProbe({ region, transport, storage, journal: async entry => { append(entry); return true; } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    console.log(JSON.stringify({ executed: false, syntheticOnly: true, productionApproved: false, maximumGreenCalls: 2,
      reason: 'EXPLICIT_EXECUTE_AFTER_SEPARATE_APPROVAL_REQUIRED' }));
  } else {
    try { const report = await execute(); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1; }
    catch { console.log(JSON.stringify({ executionState: 'unconfirmed', reason: 'STOP_AND_CHECK_PRIVATE_PROBE_JOURNAL_DO_NOT_RETRY' })); process.exitCode = 1; }
  }
}
