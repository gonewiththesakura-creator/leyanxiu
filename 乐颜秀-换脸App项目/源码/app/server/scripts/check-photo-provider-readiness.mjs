import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import * as OpenApi from '@alicloud/openapi-client';
import * as TeaUtil from '@alicloud/tea-util';
import OSS from 'ali-oss';

// Exactly four read-only actions, once each. No default credential chain, media
// upload, moderation, account/service creation, policy change or automatic retry.
// https://help.aliyun.com/zh/ram/developer-reference/api-sts-2015-04-01-getcalleridentity
// https://help.aliyun.com/zh/oss/developer-reference/getbucketlifecycle
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = 'private/photo-moderation/';
const timeout = 12_000;

export function safeFailure(error) {
  const code = String(error?.code || '');
  if (code === 'NoSuchLifecycle') return 'not_configured';
  if (['AccessDenied', 'Forbidden', 'Forbidden.RAM', 'NoPermission', 'UnauthorizedOperation'].includes(code)) return 'access_denied';
  if (['InvalidAccessKeyId', 'InvalidAccessKeyId.NotFound', 'SignatureDoesNotMatch', 'InvalidSecurityToken', 'SecurityTokenExpired'].includes(code)) return 'credential_rejected';
  if (code === 'NoSuchBucket') return 'configured_bucket_not_found';
  if (['RequestTimeout', 'ConnectionTimeoutError', 'ResponseTimeoutError', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return 'timeout';
  return 'unconfirmed';
}

export function summarizeLifecycle(rules) {
  if (rules !== null && !Array.isArray(rules)) return { readable: true, coversModerationPrefix: null, longestExpirationDays: null };
  const matches = (rules || []).filter(rule => {
    // Tag, size or exclusion predicates cannot be claimed to cover every scratch
    // object. Date-only, multipart and transition rules do not expire new images.
    const expiration = rule?.expiration;
    return rule?.status === 'Enabled' && typeof rule.prefix === 'string' && prefix.startsWith(rule.prefix)
      && !rule.tag && !rule.filter && !rule.objectSizeGreaterThan && !rule.objectSizeLessThan
      && expiration && !expiration.isAccessTime && !expiration.createdBeforeDate
      && Number.isSafeInteger(Number(expiration.days)) && Number(expiration.days) > 0;
  });
  return { readable: true, coversModerationPrefix: matches.length > 0,
    longestExpirationDays: matches.length ? Math.max(...matches.map(rule => Number(rule.expiration.days))) : null };
}

async function attempt(operation, project) {
  try { return project(await operation()); }
  catch (error) { return { readable: false, result: safeFailure(error) }; }
}

export async function checkPhotoProviderReadiness() {
  // This is the exact existing local source used by the application's Aliyun and
  // OSS clients. Missing it is an error; do not search backups or other accounts.
  const source = path.join(serverRoot, '.env');
  if (!fs.existsSync(source)) return { readOnly: true, configured: false, reason: 'EXPECTED_ENV_FILE_MISSING' };
  const env = dotenv.parse(fs.readFileSync(source));
  const names = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'];
  if (!names.every(key => typeof env[key] === 'string' && env[key].trim())) {
    return { readOnly: true, configured: false, reason: 'EXPECTED_CONFIGURATION_INCOMPLETE' };
  }
  const region = env.OSS_REGION.trim();
  if (!/^oss-cn-[a-z]+(?:-[a-z]+)?$/.test(region) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.OSS_BUCKET)) {
    return { readOnly: true, configured: false, reason: 'EXPECTED_CONFIGURATION_INVALID' };
  }
  const access = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET };
  const sts = new OpenApi.default.default(new OpenApi.default.Config({ ...access,
    endpoint: 'sts.cn-hangzhou.aliyuncs.com', regionId: 'cn-hangzhou' }));
  const oss = new OSS({ ...access, bucket: env.OSS_BUCKET, region, secure: true, retryMax: 0, timeout });
  const operations = await Promise.allSettled([
    attempt(() => sts.callApi(new OpenApi.default.Params({ action: 'GetCallerIdentity', version: '2015-04-01',
      protocol: 'HTTPS', pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
    new OpenApi.default.OpenApiRequest({}), new TeaUtil.default.RuntimeOptions({ autoretry: false, maxAttempts: 1,
      connectTimeout: timeout, readTimeout: timeout })), response => {
      const type = response?.body?.IdentityType;
      const valid = response?.statusCode === 200 && ['Account', 'RAMUser', 'AssumedRoleUser'].includes(type)
        && typeof response?.body?.AccountId === 'string' && !!response.body.AccountId;
      return { readable: true, valid, type: valid ? type : null };
    }),
    attempt(() => oss.getBucketACL(env.OSS_BUCKET, { timeout }), response => ({ readable: true, private: response.acl === 'private' })),
    attempt(() => oss.getBucketLocation(env.OSS_BUCKET, { timeout }), response => ({ readable: true, regionMatches: response.location === region })),
    attempt(() => oss.getBucketLifecycle(env.OSS_BUCKET, { timeout }), response => summarizeLifecycle(response.rules)),
  ]);
  const values = operations.map(item => item.status === 'fulfilled' ? item.value : { readable: false, result: 'unconfirmed' });
  return { readOnly: true, configured: true, identity: values[0], bucketAcl: values[1], bucketRegion: values[2],
    moderationLifecycle: values[3].result === 'not_configured'
      ? { readable: true, coversModerationPrefix: false, longestExpirationDays: null } : values[3],
    greenPermissionVerified: false, physicalDeletionVerified: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.log(JSON.stringify({ readOnly: true, configured: false, reason: 'UNEXPECTED_ARGUMENTS' }));
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await checkPhotoProviderReadiness())); }
    catch { console.log(JSON.stringify({ readOnly: true, configured: false, reason: 'READ_ONLY_CHECK_UNCONFIRMED' })); process.exitCode = 1; }
  }
}
