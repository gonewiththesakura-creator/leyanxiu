// Local-only receipt binding. Importing this module never reads a private file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { validateProbeConfig } from './probe-mini-closed-client.mjs';
import { validateDisclosureFallbackRecord, disclosureFallbackStatus } from './deploy-mini-disclosure-fallback.mjs';
import { privateRead, privateCreate } from './update-mini-017-disclosure.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fallbackMerchantProfile = 'disclosure-fallback-three-effects-v1-20261015';
export const fallbackMerchantRouteFilename = '.env.mini-disclosure-fallback-probe-20261015.json';
export const fallbackOperationId = '22e44a104421bb656feef8e1';
export const fallbackTaskId = 2363777;
const factsSha256 = '82206d8ef6dd1e4995224a878100a5ff0df99015df3d1aba0a88175da7ce7dce';
const fail = () => { throw Error('MERCHANT_PROBE_FALLBACK_BINDING_INVALID'); };
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key)));
export function fallbackPublicFacts() {
  const bytes = fs.readFileSync(path.join(server, 'docs/production-config/original-effects-public-facts-2026-10-15.json'));
  if (digest(bytes) !== factsSha256) fail();
  const facts = JSON.parse(bytes);
  return { ...facts.publicDocuments, operatorName: 'REDACTED_COMPANY_NAME', supportContact: 'REDACTED_COMPANY_CONTACT_EMAIL',
    retentionSupplierPolicy: facts.retentionSupplierPolicy, aiServices: facts.aiServiceDisclosures };
}
export async function bindFallbackProbeRoute(record, backup, snapshot) {
  validateDisclosureFallbackRecord(record); validateDisclosureFallbackRecord(backup);
  if (record.id !== fallbackOperationId || backup.id !== fallbackOperationId || record.phase !== 'submitted'
    || backup.phase !== 'prepared' || record.taskId !== fallbackTaskId || !same(immutable(record), immutable(backup))) fail();
  const status = await disclosureFallbackStatus({}, record, async () => snapshot);
  const cloud = status.cloud, order = snapshot?.order?.releaseOrderInfo;
  if (!cloud || !['candidateConfigurationVerified', 'privateIngressVerified', 'priorVersionConfigurationsUnchanged',
    'isolatedVersionHasZeroFlow', 'desiredBaseVerified', 'grayTestReleaseVerified'].every(key => cloud[key] === true)
    || cloud.candidateVersion !== 'buildtest-018' || order?.releaseVersion?.versionName !== cloud.candidateVersion
    || !Number.isSafeInteger(order.id) || order.id <= 0 || order.id === 2856443 || order.trafficType !== 'URL_PARAMS'
    || !Array.isArray(order.trafficTypeValues) || order.trafficTypeValues.length !== 1) fail();
  const gray = order.trafficTypeValues[0];
  if (!gray || Object.keys(gray).sort().join(',') !== 'key,value' || gray.value !== record.id) fail();
  const mirror = order.releaseVersion.urlParam;
  if (mirror && (mirror.key || mirror.value) && (mirror.key !== gray.key || mirror.value !== gray.value)) fail();
  const route = validateProbeConfig({ version: 1, target: { appId: record.target.appId, envId: record.target.envId,
    serviceName: record.target.serverName }, gray });
  const facts = fallbackPublicFacts(), variables = record.variables;
  if (variables.XPAY_ENV !== '0' || variables.XPAY_MODE !== 'merchant_test'
    || !Object.entries(facts).filter(([key]) => ['privacyPolicyUrl', 'userAgreementUrl', 'thirdPartyListUrl'].includes(key))
      .every(([key, value]) => variables[{ privacyPolicyUrl: 'PRIVACY_POLICY_URL', userAgreementUrl: 'USER_AGREEMENT_URL', thirdPartyListUrl: 'THIRD_PARTY_LIST_URL' }[key]] === value)
    || variables.RETENTION_SUPPLIER_POLICY !== facts.retentionSupplierPolicy
    || !same(JSON.parse(variables.AI_SERVICE_DISCLOSURES_JSON), facts.aiServices)) fail();
  return { version: 1, profile: fallbackMerchantProfile, route, operationId: record.id, taskId: record.taskId,
    candidateVersion: cloud.candidateVersion, releaseOrderId: order.id, factsSha256,
    expectedHistoricalEviction: cloud.expectedHistoricalEviction ?? null,
    recordSha256: digest(record), backupSha256: digest(backup), snapshotSha256: digest(snapshot) };
}
const journal = path.join(server, '.env.mini-disclosure-fallback.json');
export async function prepareFallbackProbeRoute({ snapshotFile, routeFile }, { read = privateRead, create = privateCreate } = {}) {
  if (!path.isAbsolute(routeFile) || path.dirname(routeFile) !== server || path.basename(routeFile) !== fallbackMerchantRouteFilename) fail();
  const record = JSON.parse(read(journal)), backup = JSON.parse(read(journal + '.backup'));
  const snapshot = JSON.parse(read(snapshotFile));
  const binding = await bindFallbackProbeRoute(record, backup, snapshot);
  // Private receipt stays in the new exclusive file. Never print its route or environment snapshot.
  create(routeFile, JSON.stringify({ ...binding, snapshot }) + '\n');
  return { prepared: true, profile: binding.profile, operationId: binding.operationId, taskId: binding.taskId,
    candidateVersion: binding.candidateVersion, releaseOrderId: binding.releaseOrderId, factsSha256 };
}
export async function loadFallbackProbeRoute(routeFile, expectedUserId, { read = privateRead } = {}) {
  if (!path.isAbsolute(routeFile) || path.dirname(routeFile) !== server || path.basename(routeFile) !== fallbackMerchantRouteFilename) fail();
  const value = JSON.parse(read(routeFile));
  const record = JSON.parse(read(journal)), backup = JSON.parse(read(journal + '.backup'));
  const binding = await bindFallbackProbeRoute(record, backup, value.snapshot);
  const { snapshot, ...saved } = value;
  if (!same(saved, binding) || !record.variables.XPAY_TEST_USER_IDS.split(',').map(v => v.trim()).includes(expectedUserId)
    || !record.variables.XPAY_REFUND_OPERATOR_USER_IDS.split(',').map(v => v.trim()).includes(expectedUserId)) fail();
  return { route: binding.route, expectedPublicFacts: fallbackPublicFacts(), binding: { operationId: binding.operationId,
    taskId: binding.taskId, candidateVersion: binding.candidateVersion, releaseOrderId: binding.releaseOrderId,
    expectedHistoricalEviction: binding.expectedHistoricalEviction,
    recordSha256: binding.recordSha256, backupSha256: binding.backupSha256, snapshotSha256: binding.snapshotSha256, factsSha256 } };
}
