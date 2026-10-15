import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeout = 12000;
const prefixes = Object.freeze({ source: 'private/mini-photo-input/', output: 'private/photo-outputs/', moderation: 'private/photo-moderation/' });
const allowed = new Set(['bucketInfo', 'versioning', 'replication', 'lifecycle', 'policy', 'publicAccessBlock']);
const list = value => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
const bool = value => value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
const days = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const errorResult = error => {
  if (['NoSuchLifecycle', 'NoSuchReplicationConfiguration', 'NoSuchBucketPolicy'].includes(error?.code)) return 'not_configured';
  if (['AccessDenied', 'Forbidden', 'Forbidden.RAM'].includes(error?.code)) return 'access_denied';
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidSecurityToken', 'SecurityTokenExpired'].includes(error?.code)) return 'credential_rejected';
  if (['RequestTimeout', 'ConnectionTimeoutError', 'ResponseTimeoutError', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code)) return 'timeout';
  return 'unconfirmed';
};

export function summarizeBucketLifecycle(rules) {
  if (rules !== null && !Array.isArray(rules)) return { readable: true, schemaConfirmed: false };
  const input = rules || [];
  const scopes = Object.fromEntries(Object.entries(prefixes).map(([scope, prefix]) => {
    // Additional filters cannot establish coverage for every object in a scope.
    const covers = input.filter(rule => rule?.status === 'Enabled' && typeof rule.prefix === 'string'
      && prefix.startsWith(rule.prefix) && Object.keys(rule).every(key => ['id', 'prefix', 'status', 'expiration',
        'noncurrentVersionExpiration', 'transition', 'noncurrentVersionTransition', 'abortMultipartUpload'].includes(key)));
    const current = covers.map(rule => rule.expiration).filter(value => value && !value.createdBeforeDate && bool(value.isAccessTime) !== true)
      .map(value => days(value.days)).filter(value => value !== null);
    const noncurrent = covers.map(rule => rule.noncurrentVersionExpiration).filter(value => value && !value.createdBeforeDate && bool(value.isAccessTime) !== true)
      .map(value => days(value.noncurrentDays)).filter(value => value !== null);
    return [scope, { unconditionalRuleCount: covers.length, currentExpirationConfigured: current.length > 0,
      currentExpirationDays: [...new Set(current)].sort((a, b) => a - b), noncurrentExpirationConfigured: noncurrent.length > 0,
      noncurrentExpirationDays: [...new Set(noncurrent)].sort((a, b) => a - b),
      expiredDeleteMarkerRemovalConfigured: covers.some(rule => bool(rule.expiration?.expiredObjectDeleteMarker) === true) }];
  }));
  return { readable: true, schemaConfirmed: true, ruleCount: input.length,
    enabledRuleCount: input.filter(rule => rule?.status === 'Enabled').length, scopes };
}

export function summarizeBucketPolicy(policy) {
  if (!policy) return { readable: true, configured: false, statementCount: 0, wildcardAllowPresent: false };
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.Statement)) return { readable: true, configured: true, schemaConfirmed: false };
  const wildcard = value => typeof value === 'string' ? ['*', 'acs:ram::*:root'].includes(value)
    : Array.isArray(value) ? value.some(wildcard) : value && typeof value === 'object' ? Object.values(value).some(wildcard) : false;
  return { readable: true, configured: true, schemaConfirmed: true, statementCount: policy.Statement.length,
    wildcardAllowPresent: policy.Statement.some(item => item?.Effect === 'Allow' && wildcard(item.Principal)),
    conditionalStatementsPresent: policy.Statement.some(item => item?.Condition && Object.keys(item.Condition).length > 0),
    effectivePublicAccessVerified: false };
}

async function quiet(operation) {
  const saved = Object.fromEntries(['log', 'error', 'warn', 'debug', 'info', 'trace', 'dir', 'table'].map(key => [key, console[key]]));
  const stdout = process.stdout.write, stderr = process.stderr.write;
  for (const key of Object.keys(saved)) console[key] = () => {};
  const discard = (chunk, encoding, callback) => { (typeof encoding === 'function' ? encoding : callback)?.(); return true; };
  process.stdout.write = discard; process.stderr.write = discard;
  try { return await operation(); }
  finally { Object.assign(console, saved); process.stdout.write = stdout; process.stderr.write = stderr; }
}

export async function inspectMiniPhotoBucketConfig() {
  return quiet(async () => {
    const source = dotenv.parse(fs.readFileSync(path.join(server, '.env')));
    if (!['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'].every(key => typeof source[key] === 'string' && source[key].trim())
      || !/^oss-cn-[a-z]+(?:-[a-z]+)?$/.test(source.OSS_REGION) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(source.OSS_BUCKET)) throw new Error('OSS_CONFIG_UNCONFIRMED');
    const OSS = (await import('ali-oss')).default;
    const client = new OSS({ accessKeyId: source.ALIYUN_ACCESS_KEY_ID, accessKeySecret: source.ALIYUN_ACCESS_KEY_SECRET,
      ...(source.ALIYUN_SECURITY_TOKEN ? { stsToken: source.ALIYUN_SECURITY_TOKEN } : {}), bucket: source.OSS_BUCKET,
      region: source.OSS_REGION, secure: true, retryMax: 0, timeout });
    const request = client.request.bind(client), called = new Set();
    client.request = params => {
      if (params.method !== 'GET' || params.bucket !== source.OSS_BUCKET || params.object || params.content || params.query
        || !allowed.has(params.subres) || called.has(params.subres)) throw new Error('OSS_READ_SCOPE_UNCONFIRMED');
      called.add(params.subres); return request(params);
    };
    const xml = async subres => {
      const params = client._bucketRequestParams('GET', source.OSS_BUCKET, subres, { timeout });
      params.xmlResponse = true; params.successStatuses = [200]; return (await client.request(params)).data;
    };
    const attempt = async (operation, project, empty) => {
      try { return project(await operation()); }
      catch (error) { const result = errorResult(error); return result === 'not_configured' && empty ? empty() : { readable: false, result }; }
    };
    const rows = await Promise.allSettled([
      attempt(() => client.getBucketInfo(source.OSS_BUCKET, { timeout }), value => {
        const b = value.bucket || {}, acl = b.AccessControlList?.Grant;
        return { readable: true, regionMatches: b.Location === source.OSS_REGION, aclRecognized: ['private', 'public-read', 'public-read-write'].includes(acl),
          bucketAclPrivate: acl === 'private', bucketAclPublicRead: ['public-read', 'public-read-write'].includes(acl), bucketAclPublicWrite: acl === 'public-read-write',
          redundancyLocal: b.DataRedundancyType === 'LRS', redundancyZone: b.DataRedundancyType === 'ZRS',
          crossRegionReplicationEnabled: b.CrossRegionReplication === 'Enabled' ? true : b.CrossRegionReplication === 'Disabled' ? false : null,
          bucketPublicAccessBlock: bool(b.BlockPublicAccess), accessLoggingConfigured: Boolean(b.BucketPolicy?.LogBucket),
          defaultEncryptionConfigured: ['KMS', 'AES256'].includes(b.ServerSideEncryptionRule?.SSEAlgorithm) };
      }),
      attempt(() => client.getBucketVersioning(source.OSS_BUCKET, { timeout }), value => ({ readable: true,
        statusRecognized: value.status === 200 && [undefined, '', 'Enabled', 'Suspended'].includes(value.versionStatus),
        enabled: value.versionStatus === 'Enabled', suspended: value.versionStatus === 'Suspended',
        unversioned: value.status === 200 && [undefined, ''].includes(value.versionStatus) })),
      attempt(() => xml('replication'), value => {
        const rules = list(value?.Rule);
        return { readable: true, configured: rules.length > 0, ruleCount: rules.length,
          activeOrStartingRules: rules.filter(rule => ['doing', 'starting'].includes(rule?.Status)).length,
          deletionReplicationInAllRules: rules.length > 0 && rules.every(rule => rule.Action === 'ALL'),
          historicalReplicationInAnyRule: rules.some(rule => rule.HistoricalObjectReplication === 'enabled'),
          destinationConfigurationVerified: false };
      }, () => ({ readable: true, configured: false, ruleCount: 0 })),
      attempt(() => client.getBucketLifecycle(source.OSS_BUCKET, { timeout }), value => summarizeBucketLifecycle(value.rules), () => summarizeBucketLifecycle([])),
      attempt(() => client.getBucketPolicy(source.OSS_BUCKET, { timeout }), value => summarizeBucketPolicy(value.policy), () => summarizeBucketPolicy(null)),
      attempt(() => xml('publicAccessBlock'), value => ({ readable: true, enabled: bool(value?.BlockPublicAccess) })),
    ]);
    const values = rows.map(row => row.status === 'fulfilled' ? row.value : { readable: false, result: 'unconfirmed' });
    return { version: 1, checkedAt: new Date().toISOString(), readOnly: true, configuredBucketOnly: true, attemptedConfigurationReads: called.size,
      noAutomaticRetries: true, listedObjects: false, readObjectBytes: false, changedConfiguration: false, deletedObjects: false,
      modelCalls: 0, moderationCalls: 0, bucket: values[0], versioning: values[1], replication: values[2], lifecycle: values[3],
      bucketPolicy: values[4], publicAccessBlock: values[5], physicalDeletionVerified: false, historicalCopiesVerifiedAbsent: false,
      providerInternalReplicasInspected: false, separateBackupProductsInspected: false };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) console.log(JSON.stringify({ mode: 'plan', readOnly: true, remoteRequests: 0, configuredBucketReadsWhenRun: 6 }));
  else if (args.length !== 1 || args[0] !== '--run') { console.error('OSS_INSPECTION_ARGUMENT_INVALID'); process.exitCode = 1; }
  else {
    const output = path.join(server, 'evidence/mini-photo-bucket-config-2026-10-12.json');
    if (fs.existsSync(output)) { console.error('OSS_INSPECTION_REPORT_ALREADY_EXISTS'); process.exitCode = 1; }
    else try {
      const report = await inspectMiniPhotoBucketConfig();
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify(report));
    } catch { console.error('OSS_INSPECTION_UNCONFIRMED'); process.exitCode = 1; }
  }
}
