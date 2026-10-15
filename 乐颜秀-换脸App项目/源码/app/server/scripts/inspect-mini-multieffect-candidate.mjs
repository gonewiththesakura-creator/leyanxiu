import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withProductionCloud, productionCloud } from './inspect-mini-production-cloud.mjs';
import { assembleMiniMultiEffectMerchantCandidate, multiEffectMerchantCandidateRecord } from './prepare-mini-multieffect-merchant-candidate.mjs';

// Read-only control-plane inspection. Existing service credentials and complete
// cloud variables stay in memory under the shared SDK-output suppression.
// This script cannot configure, upload, deploy, promote or charge anything.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scope = { envId: productionCloud.envId, serverName: 'buildtest' };
export async function inspectMultiEffectCandidate({ api, CloudAPI }) {
  const version = await api.DescribeCloudBaseRunServerVersion({ EnvId: scope.envId,
    ServerName: scope.serverName, VersionName: 'buildtest-016' });
  const base = (await CloudAPI.tcbDescribeServiceBaseConfig(scope)).serviceBaseConfig;
  const domain = await api.DescribeCloudBaseRunServiceDomain({ EnvId: scope.envId, ServiceName: scope.serverName });
  const release = await CloudAPI.tcbDescribeWxCloudBaseRunReleaseOrder({ ...scope, wxAppid: productionCloud.appId });
  if (version.VersionName !== 'buildtest-016' || version.ServerName !== scope.serverName
    || version.Status !== 'normal' || version.ContainerPort !== 3000
    || base.publicAccess === true || JSON.stringify(domain.AccessTypes) !== '["MINIAPP"]') {
    throw new Error('MULTIEFFECT_LIVE_BASELINE_UNCONFIRMED');
  }
  const variables = JSON.parse(version.EnvParams);
  const baseVariables = JSON.parse(base.envParams);
  const sameVariables = Object.keys(variables).length === Object.keys(baseVariables).length
    && Object.entries(variables).every(([key, value]) => baseVariables[key] === value);
  if (!sameVariables) throw new Error('MULTIEFFECT_BASE_CONFIG_DRIFT');
  const policyBytes = fs.readFileSync(path.join(root, 'docs/production-config/original-effects-merchant-policy-2026-10-15.json'));
  const acceptanceBytes = fs.readFileSync(path.join(root, 'evidence/mini-photo-original-effects-acceptance-bundle-2026-10-15.json'));
  const assembled = assembleMiniMultiEffectMerchantCandidate({ current: { version: version.VersionName, variables },
    policyBytes, policySha256: hash(policyBytes), acceptanceBytes, acceptanceSha256: hash(acceptanceBytes) });
  const order = release?.releaseOrderInfo;
  return { checkedAt: new Date().toISOString(), changedRemoteState: false,
    baseline: { version: version.VersionName, status: version.Status, sameBaseVariables: sameVariables,
      publicAccess: false, accessTypes: domain.AccessTypes, paymentEnv: variables.XPAY_ENV, paymentMode: variables.XPAY_MODE },
    release: { exists: release?.isExist === true, status: order?.releaseStatus ?? null,
      isReleasing: order?.isReleasing ?? null, current: order?.currentVersion?.versionName ?? null,
      candidate: order?.releaseVersion?.versionName ?? null },
    candidate: multiEffectMerchantCandidateRecord(assembled),
    liveSourceVerified: true, deployed: false, publicReleasePerformed: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await withProductionCloud(inspectMultiEffectCandidate);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^MULTIEFFECT_[A-Z_]+$/.test(error?.message || '') ? error.message : 'MULTIEFFECT_CLOUD_INSPECTION_UNCONFIRMED');
    process.exitCode = 1;
  }
}
