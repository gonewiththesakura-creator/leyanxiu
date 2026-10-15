import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decodeImageDataUrl } from '../media-validation.js';
import { createPhotoInputNormalizer } from '../photo-jobs/input-normalizer.js';
import { originalEffectIds, originalEffectsInput, originalEffectsProbeVersion,
  getOriginalEffectProfile, originalEffectBinding } from '../photo-jobs/original-effect-batch.js';
import { runBoundedPhotoGenerationProbe } from './probe-photo-generation-synthetic.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = path.resolve(root, '../../../..');
const services = Object.freeze({ input: 'baselineCheck', output: 'aigcCheck' });
const prefix = 'photo-original-generation';
export const originalEffectsExecuteFlag = '--execute-original-effects-v1';
export const originalEffectsCandidatePath = path.join(root, 'docs/production-config/original-effects-batch-2026-10-15.json');
const fail = code => { throw new Error(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const journalRelative = id => `data/${prefix}-${getOriginalEffectProfile(id).effectVersion}/intent.jsonl`;
const previewRelative = id => `evidence/mini-photo-${getOriginalEffectProfile(id).effectVersion}.png`;
const reportRelative = id => `evidence/mini-photo-${getOriginalEffectProfile(id).effectVersion}.json`;

function validateMedia(value, normalized) {
  const expectedBytes = normalized ? originalEffectsInput.normalizedByteLength : originalEffectsInput.rawByteLength;
  const expectedHash = normalized ? originalEffectsInput.normalizedSha256 : originalEffectsInput.rawSha256;
  if (!Buffer.isBuffer(value?.bytes) || value.contentType !== originalEffectsInput.contentType
    || value.byteLength !== expectedBytes || value.bytes.length !== expectedBytes
    || value.sha256 !== expectedHash || sha(value.bytes) !== expectedHash) fail('ORIGINAL_EFFECT_IMAGE_MISMATCH');
  const decoded = decodeImageDataUrl(`data:image/jpeg;base64,${value.bytes.toString('base64')}`,
    { maxBytes: 2 * 1024 * 1024, maxSide: 8192, maxPixels: 40_000_000 });
  if (decoded.width !== originalEffectsInput.width || decoded.height !== originalEffectsInput.height) fail('ORIGINAL_EFFECT_DIMENSIONS_MISMATCH');
}

export async function prepareOriginalEffectProbe({ effectId, rawBytes, normalizer = createPhotoInputNormalizer() }) {
  const profile = getOriginalEffectProfile(effectId), original = Buffer.from(rawBytes);
  validateMedia({ bytes: original, contentType: originalEffectsInput.contentType, byteLength: original.length, sha256: sha(original) }, false);
  const source = await normalizer.normalize(`data:image/jpeg;base64,${original.toString('base64')}`);
  validateMedia(source, true);
  return { source: { ...source, bytes: Buffer.from(source.bytes) }, spec: structuredClone(profile.spec), binding: originalEffectBinding(effectId) };
}

function validatePrepared(prepared) {
  const profile = getOriginalEffectProfile(prepared?.binding?.effectId);
  validateMedia(prepared.source, true);
  if (!isDeepStrictEqual(prepared.spec, profile.spec)
    || !isDeepStrictEqual(prepared.binding, originalEffectBinding(profile.effectId))) fail('ORIGINAL_EFFECT_PREPARED_MISMATCH');
  return profile;
}

function enrichReport(report, prepared, outputSha256 = report?.outputSha256) {
  const profile = validatePrepared(prepared);
  return { ...report, effectId: profile.effectId, effectVersion: profile.effectVersion, specSha256: profile.specSha256,
    acceptanceBinding: structuredClone(prepared.binding), sourceParameters: structuredClone(prepared.spec),
    outputSha256: outputSha256 || null, qualityAccepted: false,
    // An agent may independently review the image and record its own identity
    // in a separate acceptance record. This technical report never grants it.
    qualityReview: { status: 'pending-visual-review', reviewer: null, notes: null },
    manualCropAndQualityReviewRequired: false, androidDeliveryVerified: false, paymentsAttempted: 0 };
}

export async function runPreparedOriginalEffectProbe(prepared, ports) {
  validatePrepared(prepared);
  let outputSha256 = null;
  const result = await runBoundedPhotoGenerationProbe({ ...ports, ...prepared,
    probeVersion: originalEffectsProbeVersion, strictScratchBinding: true,
    journal: async entry => {
      if (entry.phase === 'output_put_confirmed') outputSha256 = entry.sha256;
      let safeEntry = entry;
      // The provider receipt is needed transiently to download the result, but
      // its signed URL must never enter a journal, report, or test output.
      if (entry.phase === 'generation_receipt' && entry.receipt) {
        const { url: _discardedUrl, ...safeReceipt } = entry.receipt;
        safeEntry = { ...entry, receipt: safeReceipt };
      }
      return ports.journal(safeEntry.phase === 'probe_finished'
        ? { ...safeEntry, report: enrichReport(safeEntry.report, prepared, outputSha256) }
        : { ...safeEntry, acceptanceBinding: prepared.binding });
    },
  });
  return enrichReport(result, prepared, outputSha256);
}

function readRegularFile(filename, maximum) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('ORIGINAL_EFFECT_FILE_INVALID');
  return fs.readFileSync(filename);
}
export function validateOriginalEffectsCandidate(candidate) {
  if (candidate?.state !== 'local-first-service-candidate-not-runtime-config'
    || candidate.probeVersion !== originalEffectsProbeVersion || candidate.provider !== 'aliyun-qwen-image'
    || candidate.model !== 'qwen-image-2.0-2026-03-03'
    || !isDeepStrictEqual({ inputKind: candidate.input?.kind, ...candidate.input && Object.fromEntries(Object.entries(candidate.input).filter(([key]) => key !== 'kind')) }, originalEffectsInput)
    || candidate.limits?.maximumGenerationCalls !== 4 || candidate.limits?.maximumGreenCalls !== 8
    || candidate.limits?.sdkRetries !== 0 || candidate.limits?.stopOnFirstFailure !== true) fail('ORIGINAL_EFFECT_CANDIDATE_MISMATCH');
  for (const id of originalEffectIds) {
    const row = candidate.effects?.find(effect => effect?.id === id), profile = getOriginalEffectProfile(id);
    if (!row || row.effectVersion !== profile.effectVersion || row.specSha256 !== profile.specSha256 || row.qualityAccepted !== false) fail('ORIGINAL_EFFECT_CANDIDATE_MISMATCH');
  }
  return true;
}
export async function prepareFixedOriginalEffectProbe(effectId) {
  const candidate = JSON.parse(readRegularFile(originalEffectsCandidatePath, 64 * 1024).toString('utf8'));
  validateOriginalEffectsCandidate(candidate);
  return prepareOriginalEffectProbe({ effectId,
    rawBytes: readRegularFile(path.join(workspace, originalEffectsInput.workspaceRelativePath), originalEffectsInput.rawByteLength) });
}

export function originalEffectProbePlan(prepared) {
  const profile = validatePrepared(prepared);
  return { executed: false, localChecksPassed: true, probeVersion: originalEffectsProbeVersion,
    effectId: profile.effectId, effectVersion: profile.effectVersion, specSha256: profile.specSha256,
    acceptanceBinding: structuredClone(prepared.binding), sourceParameters: structuredClone(prepared.spec),
    maximumGenerationCalls: 1, maximumGreenCalls: 2, moderationServices: { ...services }, sdkRetries: 0,
    thisInvocationNetworkCalls: 0, journal: journalRelative(profile.effectId), preview: previewRelative(profile.effectId),
    report: reportRelative(profile.effectId), sourceAspectRatio: '3:4', resultAspectRatio: '1:1',
    grantsExecutionAuthority: false, authorizationSource: 'active-user-session',
    executeFlag: `${originalEffectsExecuteFlag} ${profile.effectId}`, outputSha256: null,
    qualityAccepted: false, qualityReview: { status: 'pending-visual-review', reviewer: null, notes: null },
    manualCropAndQualityReviewRequired: false, androidDeliveryVerified: false,
    deployed: false, productionApproved: false, paymentsAttempted: 0,
    cleanupScope: 'this-run-exact-object-keys-only; provider-owned-result-retention-not-verified' };
}

// A following effect is never a fallback/retry for a failed one. Complete fixed
// evidence for every predecessor is required; any uncertainty stops the batch.
export function validateOriginalEffectPredecessors(effectId, histories) {
  getOriginalEffectProfile(effectId);
  for (const id of originalEffectIds.slice(0, originalEffectIds.indexOf(effectId))) {
    const entries = histories?.[id], final = Array.isArray(entries) ? entries.at(-1) : null;
    const profile = getOriginalEffectProfile(id), report = final?.report;
    const intents = Array.isArray(entries) ? entries.filter(e => e?.phase === 'generation_attempt_intent') : [];
    if (final?.phase !== 'probe_finished' || entries.filter(e => e?.phase === 'probe_finished').length !== 1
      || intents.length !== 1 || intents[0].model !== profile.spec.model
      || intents[0].sourceSha256 !== originalEffectsInput.normalizedSha256
      || report?.probeVersion !== originalEffectsProbeVersion || report.effectId !== id
      || report.effectVersion !== profile.effectVersion || report.specSha256 !== profile.specSha256
      || report.provider !== profile.spec.provider || report.model !== profile.spec.model
      || !isDeepStrictEqual(report.acceptanceBinding, originalEffectBinding(id))
      || !isDeepStrictEqual(report.sourceParameters, profile.spec)
      || report.passed !== true || report.cleanupPending !== false || report.attemptedGenerationCalls !== 1
      || report.attemptedGreenCalls !== 2 || report.qualityAccepted !== false
      || !['pending-visual-review', 'pending-manual-review'].includes(report.qualityReview?.status)
      || !/^[a-f0-9]{64}$/.test(report.outputSha256 || '')) fail('ORIGINAL_EFFECT_PREDECESSOR_UNCONFIRMED');
  }
  return true;
}

export function originalEffectOssOptions(env) {
  return { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET, region: env.OSS_REGION, secure: true, retryMax: 0, timeout: 12000 };
}
export function originalEffectGreenTransport(transport) {
  const used = new Set();
  return async request => {
    if (!Object.values(services).includes(request?.service) || used.has(request.service)) fail('ORIGINAL_EFFECT_CALL_LIMIT');
    used.add(request.service); return transport(request);
  };
}

async function execute(prepared) {
  const profile = validatePrepared(prepared), previewPath = path.join(root, previewRelative(profile.effectId));
  const reportPath = path.join(root, reportRelative(profile.effectId));
  if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(name => process.env[name])) fail('ORIGINAL_EFFECT_DEBUG_DISABLED');
  const [{ default: dotenv }, { default: debug }, { default: OSS }, { privateJournal }, qwen, moderation, marking, output] = await Promise.all([
    import('dotenv'), import('debug'), import('ali-oss'), import('./verify-photo-private-storage.mjs'),
    import('../photo-jobs/qwen-provider.js'), import('../photo-jobs/moderation.js'),
    import('../photo-jobs/image-marker.js'), import('../photo-jobs/output-storage.js'),
  ]);
  debug.disable();
  const histories = {};
  for (const id of originalEffectIds.slice(0, originalEffectIds.indexOf(profile.effectId))) {
    histories[id] = readRegularFile(path.join(root, journalRelative(id)), 1024 * 1024)
      .toString('utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  }
  validateOriginalEffectPredecessors(profile.effectId, histories);
  if (fs.existsSync(previewPath) || fs.existsSync(reportPath)) fail('ORIGINAL_EFFECT_EVIDENCE_EXISTS');
  const append = privateJournal(profile.effectVersion, { prefix, createdBy: 'original-effect-bounded-probe' });
  append({ phase: 'execution_claimed', probeVersion: originalEffectsProbeVersion, acceptanceBinding: prepared.binding,
    sourceParameters: prepared.spec, maximumGenerationCalls: 1, maximumGreenCalls: 2 });
  const required = ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'];
  // Parse only the six single-line settings required by this probe. No dotenv
  // load, inherited process-env changes, env logging, or credential artifacts.
  const selected = readRegularFile(path.join(root, '.env'), 1024 * 1024).toString('utf8').split(/\r?\n/)
    .filter(line => required.some(name => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line))).join('\n');
  const env = dotenv.parse(selected);
  if (!required.every(name => env[name]?.trim())) fail('ORIGINAL_EFFECT_CONFIGURATION_REQUIRED');
  if (qwen.checkedQwenPhotoApiEndpoint(env.DASHSCOPE_BASE).hostname === 'dashscope.aliyuncs.com') fail('ORIGINAL_EFFECT_WORKSPACE_REQUIRED');
  const region = env.OSS_REGION.replace(/^oss-/, '');
  if (region !== 'cn-shanghai') fail('ORIGINAL_EFFECT_REGION_UNVERIFIED');
  const sdk = new OSS(originalEffectOssOptions(env));
  const credential = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET };
  const moderator = moderation.createPhotoImageModerator({
    policy: { approved: true, version: originalEffectsProbeVersion, region, services, lowRisk: 'review', timeoutMs: 12000, maxBytes: 20 * 1024 * 1024 },
    storage: moderation.createOssModerationStorage({ client: sdk, bucket: env.OSS_BUCKET, region }),
    transport: originalEffectGreenTransport(moderation.createGreenImageTransport({ credential, region })),
  });
  const report = await runPreparedOriginalEffectProbe(prepared, {
    provider: qwen.createQwenPhotoProvider({ apiKey: env.DASHSCOPE_API_KEY, baseUrl: env.DASHSCOPE_BASE }),
    marker: marking.createPhotoImageMarker({ serviceProviderCode: 'REDACTED_APP_IDENTIFIER', labelVersion: originalEffectsProbeVersion }),
    moderator, outputStorage: output.createPhotoOutputOssStorage({ client: sdk, bucket: env.OSS_BUCKET, region }),
    journal: async entry => { append(entry); return true; },
    scratchInspector: async key => {
      if (!/^private\/photo-moderation\/[a-f0-9]{32}\.(jpg|png)$/.test(key)) fail('ORIGINAL_EFFECT_SCRATCH_INVALID');
      try { await sdk.head(key, { timeout: 12000 }); return { found: true }; }
      catch (error) { if (error?.status === 404 && error?.code === 'NoSuchKey') return { found: false };
        fail('ORIGINAL_EFFECT_SCRATCH_UNCONFIRMED'); }
    },
    savePreview: async bytes => fs.writeFileSync(previewPath, bytes, { flag: 'wx', mode: 0o600 }),
  });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}

// Public execution entry point uses only the fixed local material. The same
// exclusive journal protects imported calls and CLI runs against paid replay.
export async function executeFixedOriginalEffectProbe(effectId) {
  const prepared = await prepareFixedOriginalEffectProbe(effectId);
  const saved = { stdout: process.stdout.write, stderr: process.stderr.write };
  const discard = (_data, encoding, callback) => { if (typeof encoding === 'function') encoding(); else callback?.(); return true; };
  process.stdout.write = discard; process.stderr.write = discard;
  try { return await execute(prepared); }
  finally { process.stdout.write = saved.stdout; process.stderr.write = saved.stderr; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), executing = args.length === 2 && args[0] === originalEffectsExecuteFlag;
  try {
    if (executing) {
      const report = await executeFixedOriginalEffectProbe(args[1]);
      console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
    } else {
      if (args.length && !(args.length === 1 && args[0] === '--check')) fail('ORIGINAL_EFFECT_CLI_INVALID');
      const effects = [];
      for (const id of originalEffectIds) effects.push(originalEffectProbePlan(await prepareFixedOriginalEffectProbe(id)));
      console.log(JSON.stringify({ executed: false, probeVersion: originalEffectsProbeVersion,
        maximumGenerationCalls: 4, maximumGreenCalls: 8, thisInvocationNetworkCalls: 0,
        fixedOrder: [...originalEffectIds], stopOnFirstFailure: true, effects }));
    }
  } catch {
    console.log(JSON.stringify({ executed: executing ? null : false, probeVersion: originalEffectsProbeVersion,
      effectId: originalEffectIds.includes(args[1]) ? args[1] : null,
      executionState: executing ? 'unconfirmed' : 'not-started', qualityAccepted: false,
      reason: executing ? 'STOP_AND_CHECK_PRIVATE_JOURNAL_DO_NOT_REPEAT' : 'LOCAL_CHECK_FAILED_NO_NETWORK' }));
    process.exitCode = 1;
  }
}
