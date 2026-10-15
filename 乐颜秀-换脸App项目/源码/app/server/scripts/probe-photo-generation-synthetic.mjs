import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import dotenv from 'dotenv';
import debug from 'debug';
import OSS from 'ali-oss';
import { createQwenPhotoProvider, checkedQwenPhotoApiEndpoint, getPhotoProviderDiagnostic, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';
import { createPhotoImageModerator, createGreenImageTransport, createOssModerationStorage } from '../photo-jobs/moderation.js';
import { createPhotoOutputOssStorage } from '../photo-jobs/output-storage.js';
import { privateJournal } from './verify-photo-private-storage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = 'synthetic-generation-v1';
const recheckVersion = 'synthetic-generation-v2';
const workspaceVersion = 'synthetic-generation-v3';
const currentVersion = 'synthetic-generation-v4';
const versions = Object.freeze([version, recheckVersion, workspaceVersion, currentVersion]);
const historicalModel = 'qwen-image-edit-plus-2025-12-15';
// Retired runs retain their original model identity. They are evidence only,
// never executable aliases for the newly selected fixed model.
export const generationProbeModels = Object.freeze({ [version]: historicalModel, [recheckVersion]: historicalModel,
  [workspaceVersion]: historicalModel, [currentVersion]: 'qwen-image-2.0-2026-03-03' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const media = bytes => ({ bytes, byteLength: bytes.length, contentType: 'image/png', sha256: digest(bytes) });
const fail = code => { throw new Error(code); };
const services = Object.freeze({ input: 'baselineCheck', output: 'aigcCheck' });
export const generationProbeSpec = Object.freeze({ provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
  effectParameters: Object.freeze({ prompt: '将这张纯色方形测试图变为柔和的蓝色渐变背景。不要添加人物、文字或其他物体。',
    negativePrompt: '人物，文字，水印以外的符号', n: 1, watermark: true, promptExtend: false, size: '1024*1024', seed: 42 }) });
export function generationProbeInput() {
  const chunk = (kind, body) => { const type = Buffer.from(kind), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([type, body]))); return Buffer.concat([size, type, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(512); ihdr.writeUInt32BE(512, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pixels = Buffer.alloc(512 * (512 * 3 + 1), 100);
  for (let row = 0; row < 512; row++) pixels[row * (512 * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

// This is a bounded adapter acceptance, not customer work, model-effect
// approval, migration, deployment, purchase, service activation or refund.
// The CLI's exclusive fixed journal survives success/failure/process death.
export async function runPhotoGenerationProbe({ provider, marker, moderator, outputStorage, scratchInspector, journal, savePreview, probeVersion = currentVersion }) {
  if (probeVersion !== currentVersion) fail(versions.includes(probeVersion) ? 'PROBE_VERSION_RETIRED' : 'PROBE_VERSION_INVALID');
  if (QWEN_PHOTO_MODEL !== generationProbeModels[probeVersion]) fail('PROBE_MODEL_MISMATCH');
  return runBoundedPhotoGenerationProbe({ provider, marker, moderator, outputStorage, scratchInspector, journal, savePreview,
    probeVersion, source: media(generationProbeInput()), spec: generationProbeSpec, strictScratchBinding: false });
}

// Shared bounded mechanics only. Each CLI owns its immutable input/spec checks,
// explicit execution gate and exclusive journal. The historical v4 wrapper above
// remains PNG/gradient/seed42; it cannot receive a replacement input or spec.
export async function runBoundedPhotoGenerationProbe({ provider, marker, moderator, outputStorage, scratchInspector, journal,
  savePreview, probeVersion, source, spec, binding, strictScratchBinding = true }) {
  if (spec?.provider !== QWEN_PHOTO_PROVIDER || spec.model !== QWEN_PHOTO_MODEL
    || !Buffer.isBuffer(source?.bytes) || source.byteLength !== source.bytes.length || source.sha256 !== digest(source.bytes)
    || !['image/jpeg', 'image/png'].includes(source.contentType)) fail('PROBE_INPUT_SPEC_INVALID');
  source = { ...source, bytes: Buffer.from(source.bytes) }; spec = structuredClone(spec);
  const report = { executed: true, syntheticOnly: true, deployed: false, productionApproved: false,
    provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, probeVersion, resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY,
    labelVersion: probeVersion, moderationVersion: probeVersion, moderationServices: { ...services },
    maximumGenerationCalls: 1, maximumGreenCalls: 2, attemptedGenerationCalls: 0, attemptedGreenCalls: 0,
    inputAllowed: false, outputAllowed: false, marked: false, outputReadMatches: false,
    previewSaved: false, outputAbsentObserved: false, scratchAbsentObserved: 0, cleanupPending: true,
    permanentErasureConfirmed: false, historyErasureVerified: false, passed: false };
  if (binding) report.acceptanceBinding = structuredClone(binding);
  const token = randomBytes(16).toString('hex'), contentId = `probe_${token}`;
  const key = `private/photo-outputs/${token}.png`, scratch = [], scratchPutFinished = new Set(), moderationPending = new Set();
  const record = async entry => { if (await journal(entry) !== true) fail('PROBE_JOURNAL_UNCONFIRMED'); };
  let outputAttempted = false, putConfirmed = false, phase = 'prepare';
  await record({ phase: 'probe_started', contentId, maximumGenerationCalls: 1, maximumGreenCalls: 2 });
  const audit = async (direction, value) => {
    if (report.attemptedGreenCalls >= 2) fail('PROBE_CALL_LIMIT');
    await record({ phase: 'moderation_attempt_intent', direction, service: services[direction], sha256: value.sha256 });
    report.attemptedGreenCalls++;
    const extension = value.contentType === 'image/jpeg' ? 'jpg' : 'png';
    let expectedScratch;
    if (strictScratchBinding) moderationPending.add(direction);
    const receipt = await moderator.moderate({ bytes: value.bytes, contentType: value.contentType, direction,
      journal: async intent => {
        if (!/^[a-f0-9]{32}$/.test(intent?.reference || '') || intent.extension !== extension) fail('PROBE_SCRATCH_INVALID');
        const scratchKey = `private/photo-moderation/${intent.reference}.${extension}`;
        if (strictScratchBinding && (expectedScratch || scratch.includes(scratchKey))) fail('PROBE_SCRATCH_INVALID');
        expectedScratch = scratchKey;
        await record({ phase: 'scratch_intent', direction, key: scratchKey }); scratch.push(scratchKey); return true;
      } });
    await record({ phase: 'moderation_receipt', direction, receipt });
    const receiptScratch = `private/photo-moderation/${receipt.cleanupReference}.${extension}`;
    if (strictScratchBinding && (!expectedScratch || receiptScratch !== expectedScratch
      || receipt.cleanupExtension !== extension)) fail('PROBE_SCRATCH_RECEIPT_MISMATCH');
    if (receipt.cleanupPending === false && /^[a-f0-9]{32}$/.test(receipt.cleanupReference || '')) {
      scratchPutFinished.add(receiptScratch); moderationPending.delete(direction);
    }
    if (receipt.provider !== 'aliyun-green' || receipt.policyVersion !== probeVersion || receipt.service !== services[direction]
      || receipt.direction !== direction || receipt.sha256 !== value.sha256 || receipt.byteLength !== value.byteLength
      || receipt.decision !== 'allow' || receipt.cleanupPending !== false) fail('PROBE_REVIEW_UNCONFIRMED');
    return true;
  };
  try {
    phase = 'input_review';
    report.inputAllowed = await audit('input', source);
    phase = 'generation'; await record({ phase: 'generation_attempt_intent', contentId, model: QWEN_PHOTO_MODEL, sourceSha256: source.sha256 });
    report.attemptedGenerationCalls = 1;
    const receipt = await provider.generate({ input: source, spec: structuredClone(spec) });
    await record({ phase: 'generation_receipt', contentId, receipt });
    phase = 'result_read'; const generated = await provider.readGenerated({ url: receipt.url });
    phase = 'mark'; const marked = await marker.mark({ ...generated, contentId, operation: 'edit', labelVersion: probeVersion });
    if (marked.verified !== true || marked.contentId !== contentId || marked.operation !== 'edit' || marked.labelVersion !== probeVersion
      || !Buffer.isBuffer(marked.bytes) || marked.sha256 !== digest(marked.bytes) || marked.byteLength !== marked.bytes.length) fail('PROBE_MARK_UNCONFIRMED');
    report.marked = true;
    phase = 'output_put';
    if ((await outputStorage.inspect(key, { timeoutMs: 12000 }))?.found !== false) fail('PROBE_OUTPUT_KEY_OCCUPIED');
    await record({ phase: 'output_put_intent', key, sha256: marked.sha256 }); outputAttempted = true;
    const written = await outputStorage.put(key, marked.bytes, { contentType: 'image/png', timeoutMs: 12000 }); putConfirmed = true;
    if (written?.versionHeaderPresent === true) fail('PROBE_VERSIONED_OUTPUT');
    await record({ phase: 'output_put_confirmed', key, sha256: marked.sha256 });
    phase = 'output_read';
    const found = await outputStorage.read(key, { expected: { sha256: marked.sha256, byteLength: marked.byteLength, contentType: 'image/png' }, timeoutMs: 12000 });
    report.outputReadMatches = found?.found === true && found.sha256 === marked.sha256 && found.byteLength === marked.byteLength
      && Buffer.isBuffer(found.bytes) && digest(found.bytes) === marked.sha256 && found.versionHeaderPresent !== true;
    if (!report.outputReadMatches) fail('PROBE_OUTPUT_UNCONFIRMED');
    phase = 'output_review'; report.outputAllowed = await audit('output', media(found.bytes));
    if (savePreview) { phase = 'preview'; await savePreview(found.bytes); report.previewSaved = true; }
  } catch (error) {
    report.failureStage = phase; report.failure = 'OUTCOME_UNCONFIRMED_DO_NOT_REPEAT';
    const diagnostic = getPhotoProviderDiagnostic(error);
    if (diagnostic) report.diagnostic = diagnostic;
  } finally {
    let cleanupConfirmed = moderationPending.size === 0 && scratch.every(scratchKey => scratchPutFinished.has(scratchKey));
    if (outputAttempted) {
      try {
        await record({ phase: 'output_delete_intent', key });
        const result = await outputStorage.delete(key, { timeoutMs: 12000 });
        report.outputAbsentObserved = result?.acknowledged === true && result.absentObserved === true && result.versionMarkerObserved !== true;
        cleanupConfirmed &&= report.outputAbsentObserved && putConfirmed;
      } catch { cleanupConfirmed = false; }
    }
    for (const scratchKey of scratch) {
      try {
        await record({ phase: 'scratch_observe_intent', key: scratchKey });
        if ((await scratchInspector(scratchKey))?.found === false) report.scratchAbsentObserved++;
        else cleanupConfirmed = false;
      } catch { cleanupConfirmed = false; }
    }
    report.cleanupPending = !cleanupConfirmed;
    report.passed = !report.failure && report.inputAllowed && report.outputAllowed && report.marked
      && report.outputReadMatches && report.outputAbsentObserved && !report.cleanupPending;
    await record({ phase: 'probe_finished', report });
  }
  return report;
}

// Evidence is a prerequisite, never authorization. A new explicit CLI version
// must be separately approved; it cannot replay a completed journal.
export function validateGenerationProbePredecessors(probeVersion, histories) {
  const index = versions.indexOf(probeVersion);
  if (index < 0) fail('PROBE_VERSION_INVALID');
  for (const priorVersion of versions.slice(0, index)) {
    const entries = histories?.[priorVersion], final = Array.isArray(entries) ? entries.at(-1) : null;
    // The original fixed v1 journal predates the version field. Read its old
    // format as-is; never rewrite it or generalize this exception to v2/v3.
    const versionMatches = final?.report?.probeVersion === priorVersion
      || (priorVersion === version && final?.report?.probeVersion === undefined);
    const intent = Array.isArray(entries) ? entries.find(entry => entry?.phase === 'generation_attempt_intent') : null;
    const modelMatches = intent?.model === generationProbeModels[priorVersion]
      && (final?.report?.model === generationProbeModels[priorVersion]
        || (priorVersion === version && final?.report?.model === undefined));
    if (final?.phase !== 'probe_finished' || !versionMatches
      || !modelMatches
      || final.report.attemptedGenerationCalls !== 1 || final.report.passed !== false || final.report.cleanupPending !== false
      || entries.filter(entry => entry?.phase === 'generation_attempt_intent').length !== 1
      || entries.filter(entry => entry?.phase === 'probe_finished').length !== 1) fail('PROBE_PRIOR_EVIDENCE_REQUIRED');
  }
  return true;
}

async function execute(probeVersion = currentVersion) {
  if (probeVersion !== currentVersion || QWEN_PHOTO_MODEL !== generationProbeModels[probeVersion]) fail('PROBE_VERSION_RETIRED');
  if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(name => process.env[name])) fail('PROBE_DEBUG_DISABLED');
  debug.disable();
  const histories = {};
  for (const priorVersion of versions.slice(0, versions.indexOf(probeVersion))) {
    const priorPath = path.join(root, 'data', `photo-generation-${priorVersion}`, 'intent.jsonl');
    const priorStat = fs.lstatSync(priorPath);
    if (!priorStat.isFile() || priorStat.isSymbolicLink() || priorStat.size > 1024 * 1024) fail('PROBE_PRIOR_EVIDENCE_REQUIRED');
    histories[priorVersion] = fs.readFileSync(priorPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  }
  validateGenerationProbePredecessors(probeVersion, histories);
  const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  if (probeVersion === currentVersion) {
    // The catalog-confirmed fixed model uses the reviewed Beijing workspace.
    // No fallback endpoint, rolling model, region or automatic paid retry.
    if (!env.DASHSCOPE_BASE || checkedQwenPhotoApiEndpoint(env.DASHSCOPE_BASE).hostname === 'dashscope.aliyuncs.com') fail('PROBE_WORKSPACE_ENDPOINT_REQUIRED');
  }
  if (!['DASHSCOPE_API_KEY', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'].every(k => env[k]?.trim())) fail('PROBE_CONFIGURATION_REQUIRED');
  const region = env.OSS_REGION.replace(/^oss-/, '');
  if (region !== 'cn-shanghai') fail('PROBE_REVIEW_REGION_NOT_VERIFIED');
  const credential = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET };
  const sdk = new OSS({ ...credential, bucket: env.OSS_BUCKET, region: env.OSS_REGION, secure: true, retryMax: 0 });
  const storage = createOssModerationStorage({ client: sdk, bucket: env.OSS_BUCKET, region });
  const rawTransport = createGreenImageTransport({ credential, region }); const used = new Set();
  const transport = async request => { if (!Object.values(services).includes(request.service) || used.has(request.service)) fail('PROBE_CALL_LIMIT');
    used.add(request.service); return rawTransport(request); };
  const moderator = createPhotoImageModerator({ policy: { approved: true, version: probeVersion, region, services, lowRisk: 'review', timeoutMs: 12000, maxBytes: 20 * 1024 * 1024 }, storage, transport });
  const provider = createQwenPhotoProvider({ apiKey: env.DASHSCOPE_API_KEY, baseUrl: env.DASHSCOPE_BASE });
  // Actual known mini-program identity; no invented certification or provider code.
  const marker = createPhotoImageMarker({ serviceProviderCode: 'REDACTED_APP_IDENTIFIER', labelVersion: probeVersion });
  const outputStorage = createPhotoOutputOssStorage({ client: sdk, bucket: env.OSS_BUCKET, region });
  const append = privateJournal(probeVersion, { prefix: 'photo-generation', createdBy: 'synthetic-generation-probe' });
  return runPhotoGenerationProbe({ provider, marker, moderator, outputStorage, probeVersion, journal: async entry => { append(entry); return true; },
    scratchInspector: async key => { try { await sdk.head(key, { timeout: 12000 }); return { found: true }; }
      catch (error) { if (error?.status === 404 && error?.code === 'NoSuchKey') return { found: false }; throw new Error('PROBE_SCRATCH_UNCONFIRMED'); } },
    savePreview: async bytes => fs.writeFileSync(path.join(root, 'evidence', `mini-photo-${probeVersion}.png`), bytes, { flag: 'wx' }),
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute-model-v4') {
    console.log(JSON.stringify({ executed: false, maximumGenerationCalls: 1, maximumGreenCalls: 2,
      probeVersion: currentVersion, model: QWEN_PHOTO_MODEL, syntheticOnly: true, estimatedModelAndBaseReviewYuan: 0.203,
      excludes: 'OSS requests/traffic and optional review additions; not an account spending cap',
      reason: ['--execute', '--execute-v2', '--execute-workspace-v3'].includes(process.argv[2])
        ? 'RETIRED_PROBE_NOT_EXECUTABLE' : 'EXPLICIT_EXECUTE_AFTER_SCOPED_APPROVAL_REQUIRED' }));
  } else {
    try { const report = await execute(currentVersion); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1; }
    catch { console.log(JSON.stringify({ executionState: 'unconfirmed', reason: 'STOP_AND_CHECK_PRIVATE_JOURNAL_DO_NOT_REPEAT' })); process.exitCode = 1; }
  }
}
