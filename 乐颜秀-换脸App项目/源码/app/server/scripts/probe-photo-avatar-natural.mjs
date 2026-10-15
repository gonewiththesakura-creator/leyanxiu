import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decodeImageDataUrl } from '../media-validation.js';
import { createPhotoInputNormalizer } from '../photo-jobs/input-normalizer.js';
import { runBoundedPhotoGenerationProbe } from './probe-photo-generation-synthetic.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inputPath = 'D:/JT/乐颜秀/workspace/output/imagegen/fictional-adult-avatar-20261012.jpg';
const candidatePath = path.join(root, 'docs/production-config/first-service-candidate-2026-10-12.json');
const fail = code => { throw new Error(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
export const avatarProbeVersion = 'natural-avatar-v1-20261012';
export const avatarProbeExecuteFlag = '--execute-natural-avatar-v1';
export const avatarProbeIdentity = Object.freeze({
  inputKind: 'ai-generated-fictional-adult-portrait', contentType: 'image/jpeg', width: 768, height: 1024,
  rawByteLength: 133268, rawSha256: '56eb47602d36864b6eec9514ddb091cfa2b71309558c3e12917b3970329b947f',
  normalizedByteLength: 206503, normalizedSha256: 'f71c5d5a76157abfc260125935667e93370235f8caf296842202bdbf825cf018',
});
export const avatarProbeSpec = Object.freeze({ provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03',
  effectParameters: Object.freeze({
    prompt: '以输入照片为唯一人物参考，严格保留同一个人的身份、五官、脸型、肤色、真实年龄、发型、神态和主要构图；只执行指定效果。不要换脸，不增加人物，不改变性别，不添加文字、标志或边框。制作自然高级的个人头像，干净中性背景、专业柔光和头肩构图，保留真实年龄。输出一张高清完整照片。',
    negativePrompt: '', size: '1024*1024', n: 1, watermark: true, promptExtend: false,
  }) });
export const avatarProbeSpecSha256 = sha(JSON.stringify(avatarProbeSpec));
export const avatarProbeV2Version = 'natural-avatar-v2-20261013';
export const avatarProbeV2Spec = Object.freeze({ ...avatarProbeSpec, effectParameters: Object.freeze({
  ...avatarProbeSpec.effectParameters,
  prompt: '仅对人物轮廓外的原有灰色背景做轻微柔光调整。人物外观保持与输入图像一致：保留原有五官、表情、皮肤纹理、肤色、发型和衣服，不重新设计人物。',
  negativePrompt: '面部重绘，新增皱纹，新增色斑，皮肤粗糙化，过度磨皮，改变五官，改变表情，改变人物年龄观感',
}) });
const profileFor = version => {
  if (version === avatarProbeVersion) return { version, spec: avatarProbeSpec, specSha256: avatarProbeSpecSha256,
    candidatePath, executeFlag: avatarProbeExecuteFlag, preview: 'mini-photo-natural-avatar-v1-20261012.png' };
  if (version === avatarProbeV2Version) return { version, spec: avatarProbeV2Spec, specSha256: sha(JSON.stringify(avatarProbeV2Spec)),
    candidatePath: path.join(root, 'docs/production-config/natural-avatar-revision-v2-2026-10-13.json'),
    executeFlag: '--execute-natural-avatar-v2', preview: 'mini-photo-natural-avatar-v2-20261013.png' };
  fail('AVATAR_VERSION_INVALID');
};
const services = Object.freeze({ input: 'baselineCheck', output: 'aigcCheck' });

export function validateAvatarCandidate(candidate, version = avatarProbeVersion) {
  const profile = profileFor(version);
  const e = candidate?.effect, i = candidate?.selectedAcceptanceInput;
  if (candidate?.state !== 'local-first-service-candidate-not-runtime-config'
    || e?.id !== 'natural-avatar' || e.version !== version || e.purpose !== 'photo-effect:natural-avatar'
    || !isDeepStrictEqual({ provider: e.provider, model: e.model, effectParameters: e.parameters }, profile.spec)) fail('AVATAR_CANDIDATE_MISMATCH');
  if (i?.kind !== avatarProbeIdentity.inputKind || i.workspaceRelativePath !== 'output/imagegen/fictional-adult-avatar-20261012.jpg'
    || i.contentType !== avatarProbeIdentity.contentType || i.width !== avatarProbeIdentity.width || i.height !== avatarProbeIdentity.height
    || i.byteLength !== avatarProbeIdentity.rawByteLength || i.sha256 !== avatarProbeIdentity.rawSha256) fail('AVATAR_INPUT_BINDING_MISMATCH');
  return true;
}

function validateMedia(value, normalized) {
  const expectedBytes = normalized ? avatarProbeIdentity.normalizedByteLength : avatarProbeIdentity.rawByteLength;
  const expectedHash = normalized ? avatarProbeIdentity.normalizedSha256 : avatarProbeIdentity.rawSha256;
  if (!Buffer.isBuffer(value?.bytes) || value.contentType !== 'image/jpeg' || value.bytes.length !== expectedBytes
    || value.byteLength !== expectedBytes || value.sha256 !== expectedHash || sha(value.bytes) !== expectedHash) fail('AVATAR_IMAGE_MISMATCH');
  const info = decodeImageDataUrl(`data:image/jpeg;base64,${value.bytes.toString('base64')}`,
    { maxBytes: 2 * 1024 * 1024, maxSide: 8192, maxPixels: 40_000_000 });
  if (info.width !== avatarProbeIdentity.width || info.height !== avatarProbeIdentity.height) fail('AVATAR_DIMENSIONS_MISMATCH');
}

export async function prepareAvatarProbe({ candidate, rawBytes, normalizer = createPhotoInputNormalizer(), version = avatarProbeVersion }) {
  const profile = profileFor(version);
  validateAvatarCandidate(candidate, version);
  const original = Buffer.from(rawBytes);
  validateMedia({ bytes: original, contentType: 'image/jpeg', byteLength: original.length, sha256: sha(original) }, false);
  const source = await normalizer.normalize(`data:image/jpeg;base64,${original.toString('base64')}`);
  validateMedia(source, true);
  return { source: { ...source, bytes: Buffer.from(source.bytes) }, spec: structuredClone(profile.spec),
    binding: { ...avatarProbeIdentity, specSha256: profile.specSha256, effectId: 'natural-avatar', effectVersion: version } };
}

export async function runPreparedAvatarProbe(prepared, ports) {
  const profile = profileFor(prepared?.binding?.effectVersion);
  validateMedia(prepared?.source, true);
  if (!isDeepStrictEqual(prepared.spec, profile.spec)
    || !isDeepStrictEqual(prepared.binding, { ...avatarProbeIdentity, specSha256: profile.specSha256,
      effectId: 'natural-avatar', effectVersion: profile.version })) fail('AVATAR_PREPARED_BINDING_MISMATCH');
  return runBoundedPhotoGenerationProbe({ ...ports, ...prepared, probeVersion: profile.version, strictScratchBinding: true });
}

function readLocalRegularFile(filename, maximum) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) fail('AVATAR_LOCAL_FILE_INVALID');
  return fs.readFileSync(filename);
}
export async function prepareFixedAvatarProbe(version = avatarProbeVersion) {
  const profile = profileFor(version);
  const candidate = JSON.parse(readLocalRegularFile(profile.candidatePath, 64 * 1024).toString('utf8'));
  return prepareAvatarProbe({ candidate, rawBytes: readLocalRegularFile(inputPath, avatarProbeIdentity.rawByteLength), version });
}

export function avatarProbePlan(prepared) {
  const profile = profileFor(prepared?.binding?.effectVersion);
  validateMedia(prepared.source, true);
  return { executed: false, localChecksPassed: true, probeVersion: profile.version,
    inputKind: avatarProbeIdentity.inputKind, inputSha256: avatarProbeIdentity.rawSha256,
    normalizedSha256: avatarProbeIdentity.normalizedSha256, specSha256: profile.specSha256,
    model: profile.spec.model, maximumGenerationCalls: 1, maximumGreenCalls: 2, moderationServices: { ...services },
    sdkRetries: 0, thisInvocationNetworkCalls: 0, grantsExecutionAuthority: false,
    authorizationSource: 'active-user-session', executeFlag: profile.executeFlag,
    journal: `data/photo-avatar-generation-${profile.version}/intent.jsonl`,
    preview: `evidence/${profile.preview}`,
    sourceAspectRatio: '3:4', resultAspectRatio: '1:1', manualCropAndQualityReviewRequired: true,
    payments: false, activation: false, deployment: false, cloudConfigurationChanges: false,
    qualityAccepted: false, androidDeliveryVerified: false,
    cleanupScope: 'this-run-exact-object-keys-only; provider-owned-result-retention-not-verified' };
}

export function avatarOssOptions(env) {
  return { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET, region: env.OSS_REGION, secure: true, retryMax: 0, timeout: 12000 };
}
export function singleUseGreenTransport(transport) {
  const used = new Set();
  return async request => {
    if (!Object.values(services).includes(request?.service) || used.has(request.service)) fail('AVATAR_CALL_LIMIT');
    used.add(request.service); return transport(request);
  };
}

// Only the exact execution flag enters here within the user's authorized scope.
// Authorization belongs to the active user session; a stale candidate record or
// successful preflight cannot grant or revoke it. Exclusive journals still prevent
// replay of an attempt. No histories or retired journals are read here.
async function execute(prepared) {
  const profile = profileFor(prepared?.binding?.effectVersion);
  const probeVersion = profile.version;
  const previewPath = path.join(root, 'evidence', profile.preview);
  if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(name => process.env[name])) fail('AVATAR_DEBUG_DISABLED');
  const [{ default: dotenv }, { default: debug }, { default: OSS }, { privateJournal }, qwen, moderation, marking, output] = await Promise.all([
    import('dotenv'), import('debug'), import('ali-oss'), import('./verify-photo-private-storage.mjs'),
    import('../photo-jobs/qwen-provider.js'), import('../photo-jobs/moderation.js'),
    import('../photo-jobs/image-marker.js'), import('../photo-jobs/output-storage.js'),
  ]);
  debug.disable();
  if (fs.existsSync(previewPath)) fail('AVATAR_PREVIEW_ALREADY_EXISTS');
  const append = privateJournal(probeVersion, { prefix: 'photo-avatar-generation', createdBy: 'fictional-adult-avatar-probe' });
  append({ phase: 'execution_claimed', binding: prepared.binding, maximumGenerationCalls: 1, maximumGreenCalls: 2 });
  const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  if (!['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION']
    .every(name => env[name]?.trim())) fail('AVATAR_CONFIGURATION_REQUIRED');
  if (qwen.checkedQwenPhotoApiEndpoint(env.DASHSCOPE_BASE).hostname === 'dashscope.aliyuncs.com') fail('AVATAR_WORKSPACE_REQUIRED');
  const region = env.OSS_REGION.replace(/^oss-/, '');
  if (region !== 'cn-shanghai') fail('AVATAR_REGION_UNVERIFIED');
  const sdk = new OSS(avatarOssOptions(env));
  const credential = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET };
  const moderator = moderation.createPhotoImageModerator({
    policy: { approved: true, version: probeVersion, region, services, lowRisk: 'review', timeoutMs: 12000, maxBytes: 20 * 1024 * 1024 },
    storage: moderation.createOssModerationStorage({ client: sdk, bucket: env.OSS_BUCKET, region }),
    transport: singleUseGreenTransport(moderation.createGreenImageTransport({ credential, region })),
  });
  const report = await runPreparedAvatarProbe(prepared, {
    provider: qwen.createQwenPhotoProvider({ apiKey: env.DASHSCOPE_API_KEY, baseUrl: env.DASHSCOPE_BASE }),
    marker: marking.createPhotoImageMarker({ serviceProviderCode: 'REDACTED_APP_IDENTIFIER', labelVersion: probeVersion }),
    moderator, outputStorage: output.createPhotoOutputOssStorage({ client: sdk, bucket: env.OSS_BUCKET, region }),
    journal: async entry => { append(entry); return true; },
    scratchInspector: async key => {
      if (!/^private\/photo-moderation\/[a-f0-9]{32}\.(jpg|png)$/.test(key)) fail('AVATAR_SCRATCH_INVALID');
      try { await sdk.head(key, { timeout: 12000 }); return { found: true }; }
      catch (error) { if (error?.status === 404 && error?.code === 'NoSuchKey') return { found: false };
        throw new Error('AVATAR_SCRATCH_UNCONFIRMED'); }
    },
    savePreview: async bytes => fs.writeFileSync(previewPath, bytes, { flag: 'wx', mode: 0o600 }),
  });
  // A successful adapter probe still needs a human to assess identity/crop and
  // does not verify the Android delivery path or approve this effect for sale.
  return { ...report, qualityAccepted: false, androidDeliveryVerified: false, paymentsAttempted: 0 };
}

async function quietExecute(prepared) {
  const saved = { stdout: process.stdout.write, stderr: process.stderr.write };
  const discard = (_data, encoding, callback) => { if (typeof encoding === 'function') encoding(); else callback?.(); return true; };
  process.stdout.write = discard; process.stderr.write = discard;
  try { return await execute(prepared); }
  finally { process.stdout.write = saved.stdout; process.stderr.write = saved.stderr; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const version = ['--check-v2', '--execute-natural-avatar-v2'].includes(args[0]) ? avatarProbeV2Version : avatarProbeVersion;
  const executing = args.length === 1 && args[0] === profileFor(version).executeFlag;
  try {
    if (args.length && !executing && !(args.length === 1 && ['--check', '--check-v2'].includes(args[0]))) fail('AVATAR_CLI_INVALID');
    const prepared = await prepareFixedAvatarProbe(version);
    const report = executing ? await quietExecute(prepared) : avatarProbePlan(prepared);
    console.log(JSON.stringify(report)); if (executing && !report.passed) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ executed: executing ? null : false, executionState: executing ? 'unconfirmed' : 'not-started',
      reason: executing ? 'STOP_AND_CHECK_NEW_PRIVATE_JOURNAL_DO_NOT_REPEAT' : 'LOCAL_INPUT_OR_CANDIDATE_CHECK_FAILED_NO_NETWORK' }));
    process.exitCode = 1;
  }
}
