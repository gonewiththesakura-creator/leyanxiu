import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { withProductionCloud, inspectProductionCloud } from './inspect-mini-production-cloud.mjs';
import { readDisclosureFallbackState, validateDisclosureFallbackRecord, inspectDisclosureFallback, disclosureFallbackStatus } from './deploy-mini-disclosure-fallback.mjs';
import { merchantTestProduct } from './prepare-mini-production-merchant-test.mjs';
// Control-plane reads only. Never invokes client auth, callbacks, payments,
// providers, promotion, traffic configuration or a deployment mutation.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = value => JSON.parse(value || '{}');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const withoutMetadata = value => Object.fromEntries(Object.entries(value).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'VersionIP', 'requestId', 'createdTime', 'updatedTime', 'versionIp',
    'CpuTotalQuota', 'MemTotalQuota', 'cpuTotalQuota', 'memTotalQuota'].includes(key)));
export function otherServiceFingerprints(inventories) {
  const other = inventories.filter(item => item.serverName !== 'buildtest').sort((a, b) => a.serverName.localeCompare(b.serverName));
  if (!same(other.map(item => item.serverName), ['leyanxiu-api', 'leyanxiu-stage'])) throw Error('BOUNDARY_OTHER_SERVICES_UNCONFIRMED');
  return other.map(item => ({ service: item.serverName, fingerprintSha256: hash(canonical({
    base: { ...withoutMetadata(item.base), envParams: env(item.base.envParams) }, domain: withoutMetadata(item.domain),
    task: item.task && { id: item.task.id, status: item.task.status },
    versions: item.versions.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio, remark: v.Remark })).sort((a, b) => a.name.localeCompare(b.name)),
    active: item.active.map(v => ({ ...withoutMetadata(v), ...(v.envParams !== undefined ? { envParams: env(v.envParams) } : {}),
      ...(v.EnvParams !== undefined ? { EnvParams: env(v.EnvParams) } : {}) })).sort((a, b) => canonical(a).localeCompare(canonical(b)))
  })) }));
}
export async function evaluate018Boundary(record, snapshot, inventories) {
  validateDisclosureFallbackRecord(record);
  if (record.id !== '22e44a104421bb656feef8e1' || record.taskId !== 2363777 || record.phase !== 'submitted') throw Error('BOUNDARY_OPERATION_UNCONFIRMED');
  const status = await disclosureFallbackStatus({}, record, async () => snapshot), cloud = status.cloud;
  const info = snapshot.order?.releaseOrderInfo, current = snapshot.versions.find(v => v.VersionName === 'buildtest-016');
  const candidate = snapshot.versions.find(v => v.VersionName === 'buildtest-018');
  const scoped = cloud.candidateVersion === 'buildtest-018' && snapshot.order?.isExist === true
    && Number.isSafeInteger(info?.id) && info.id > 0 && info.id !== 2856443 && info.serverName === 'buildtest'
    && info.currentVersion?.versionName === 'buildtest-016' && info.releaseVersion?.versionName === 'buildtest-018';
  const sameConfig = ['candidateConfigurationVerified', 'privateIngressVerified', 'priorVersionConfigurationsUnchanged',
    'isolatedVersionHasZeroFlow', 'desiredBaseVerified'].every(key => cloud[key] === true);
  const flowOnly = name => snapshot.versions.every(v => v.Status === 'normal' && v.FlowRatio === (v.VersionName === name ? 100 : 0));
  const testRouteBound = info?.trafficType === 'URL_PARAMS' && info.trafficTypeValues?.length === 1
    && typeof info.trafficTypeValues[0]?.key === 'string' && info.trafficTypeValues[0].key.length > 0
    && info.trafficTypeValues[0].value === record.id;
  const pre = scoped && sameConfig && info.releaseStatus === 'test' && info.isReleasing === true && snapshot.task.status === 'running'
    && testRouteBound && snapshot.versions.every(v => v.Status === 'normal' && v.FlowRatio === 0);
  const post = scoped && sameConfig && info.releaseStatus === 'success' && info.isReleasing === false && snapshot.task.status === 'finished'
    && info.trafficType === 'FLOW' && same(info.trafficTypeValues, []) && flowOnly('buildtest-018');
  const variables = env(snapshot.candidate?.EnvParams), expected = record.variables;
  return { checkedAt: new Date().toISOString(), remoteStateChanged: false, operationId: record.id, taskId: record.taskId,
    candidateVersion: cloud.candidateVersion, releaseOrderId: scoped ? info.id : null,
    controlPlane: { beforePromotionVerified: Boolean(pre), afterPromotionVerified: Boolean(post),
      candidateConfigurationVerified: cloud.candidateConfigurationVerified, desiredBaseVerified: cloud.desiredBaseVerified,
      allPriorVersionConfigurationsUnchanged: cloud.priorVersionConfigurationsUnchanged,
      expectedHistoricalEviction: cloud.expectedHistoricalEviction,
      privateMiniappIngressUnchanged: cloud.privateIngressVerified, isolated017ZeroFlow: cloud.isolatedVersionHasZeroFlow,
      rollback016Available: current?.Status === 'normal' && cloud.priorVersionConfigurationsUnchanged,
      candidateNormal: candidate?.Status === 'normal', candidateIsOnlyDefault: Boolean(candidate && flowOnly('buildtest-018')) },
    merchant: { env0: variables.XPAY_ENV === '0', modeMerchantTest: variables.XPAY_MODE === 'merchant_test',
      enabledAndReconciliationPreserved: variables.XPAY_ENABLED === 'true' && variables.XPAY_RECONCILE_ENABLED === 'true',
      exactAllowlistPreserved: variables.XPAY_TEST_USER_IDS === expected.XPAY_TEST_USER_IDS && variables.XPAY_REFUND_OPERATOR_USER_IDS === expected.XPAY_REFUND_OPERATOR_USER_IDS,
      exactProduct990Fen10Photos365Days: same(env(variables.XPAY_PRODUCTS_JSON), [merchantTestProduct]),
      allVariablesExact: same(variables, expected) },
    otherCloudServices: otherServiceFingerprints(inventories),
    callback: { path: '/api/mini/payments/notify/cloud', expectedService: 'buildtest',
      defaultServiceRoutesTo018: Boolean(post), currentMessageBindingVerified: false, officialDeliveryTo018Verified: false,
      clientGrayParametersDoNotVerifyCallbackRouting: true },
    boundaries: { original017RequestOutcomeKnown: false, nativeEcsDeploymentInspected: false,
      currentUploadedNativeUiVerified: false, nativeRuntimeReadsPerformed: false, paymentCalled: false, generationCalled: false } };
}
export async function inspect018Boundary(adapter) {
  const record = readDisclosureFallbackState();
  const snapshot = await inspectDisclosureFallback(adapter, 'buildtest-018');
  const inventories = await inspectProductionCloud(adapter);
  const report = await evaluate018Boundary(record, snapshot, inventories);
  const filename = path.join(server, 'evidence/mini-native-product-development-upload-2026-10-15.json'), bytes = fs.readFileSync(filename), evidence = JSON.parse(bytes);
  return { ...report, recordedNativeUi: { evidenceSha256: hash(bytes), recordedVersion: evidence.version,
    originalFiveTabsRecorded: same(evidence.tabs, ['推荐', '视频玩法', '精选', '百变图片', '我的']),
    developmentUploadRecorded: evidence.developmentCodeUploaded === true, currentPlatformReinspectionPerformed: false } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || args.length === 1 && args[0] === 'plan') console.log(JSON.stringify({ action: 'plan', readsPrivateJournal: false,
      cloudOperationPerformed: false, command: 'status', operations: ['read exact 018 release and every prior version', 'read three cloud-service inventories'], mutationMethods: [] }));
    else if (args.length === 1 && args[0] === 'status') console.log(JSON.stringify(await withProductionCloud(inspect018Boundary)));
    else throw Error('BOUNDARY_ARGUMENT_INVALID');
  } catch (error) { console.error(/^BOUNDARY_[A-Z_]+$/.test(error?.message || '') ? error.message : 'BOUNDARY_READONLY_UNCONFIRMED'); process.exitCode = 1; }
}
