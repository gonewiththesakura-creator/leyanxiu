// Dedicated SMS identity only. Never prints or writes AccessKey material locally.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

const USER = 'leyanxiu-app-sms';
const POLICY = 'LeyanxiuAppSmsSendOnly';
const COMMENT = 'Leyanxiu Android account SMS only; no console login; ECS REDACTED_COMPANY_INFRASTRUCTURE';
const INSTANCE = 'REDACTED_COMPANY_CLOUD_INSTANCE';
const REMOTE_INPUT = '/etc/leyanxiu-app-account/incoming-sms/app-sms.json';
const encode = x => encodeURIComponent(x).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
let credentials;
const canonicalObject = value => Array.isArray(value) ? value.map(canonicalObject)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonicalObject(value[k])])) : value;
async function ram(Action, extra = {}) {
  credentials ||= dotenv.parse(fs.readFileSync(new URL('../.env', import.meta.url)));
  const values = { AccessKeyId: credentials.ALIYUN_ACCESS_KEY_ID, Action, Format: 'JSON', Version: '2015-05-01',
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...extra };
  const canonical = Object.keys(values).sort().map(k => `${encode(k)}=${encode(values[k])}`).join('&');
  values.Signature = crypto.createHmac('sha1', `${credentials.ALIYUN_ACCESS_KEY_SECRET}&`).update(`POST&%2F&${encode(canonical)}`).digest('base64');
  const response = await fetch('https://ram.aliyuncs.com/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || result.Code) throw new Error(/^[A-Za-z0-9_.-]+$/.test(result.Code || '') ? result.Code : 'RAM_REQUEST_FAILED');
  return result;
}
async function existing(Action, extra, absent) {
  try { return await ram(Action, extra); } catch (e) { if (e.message === absent) return null; throw e; }
}
export function smsIdentityPolicy() {
  return { Version: '1', Statement: [{ Effect: 'Allow', Action: ['dysms:SendSms'], Resource: ['*'],
    Condition: { IpAddress: { 'acs:SourceIp': ['REDACTED_COMPANY_INFRASTRUCTURE'] }, Bool: { 'acs:SecureTransport': ['true'] } } }] };
}
async function inspect() {
  const user = await existing('GetUser', { UserName: USER }, 'EntityNotExist.User');
  const policy = await existing('GetPolicy', { PolicyType: 'Custom', PolicyName: POLICY }, 'EntityNotExist.Policy');
  if (user && user.User.Comments !== COMMENT) throw new Error('EXISTING_USER_REVIEW_REQUIRED');
  if (policy) {
    const version = await ram('GetPolicyVersion', { PolicyType: 'Custom', PolicyName: POLICY, VersionId: policy.Policy.DefaultVersion });
    let actual = version.PolicyVersion.PolicyDocument;
    if (typeof actual === 'string') {
      try { actual = JSON.parse(actual); } catch { actual = JSON.parse(decodeURIComponent(actual)); }
    }
    if (JSON.stringify(canonicalObject(actual)) !== JSON.stringify(canonicalObject(smsIdentityPolicy()))) throw new Error('EXISTING_POLICY_REVIEW_REQUIRED');
  }
  let keys = [];
  if (user) {
    const policies = (await ram('ListPoliciesForUser', { UserName: USER })).Policies?.Policy || [];
    const groups = (await ram('ListGroupsForUser', { UserName: USER })).Groups?.Group || [];
    const login = await existing('GetLoginProfile', { UserName: USER }, 'EntityNotExist.User.LoginProfile');
    if (groups.length || login || policies.some(p => p.PolicyName !== POLICY || p.PolicyType !== 'Custom')) throw new Error('EXISTING_IDENTITY_SCOPE_UNSAFE');
    keys = (await ram('ListAccessKeys', { UserName: USER })).AccessKeys?.AccessKey || [];
  }
  return { user, policy, keyCount: keys.length };
}
async function main(mode = 'plan') {
  if (mode === 'plan') {
    console.log(JSON.stringify({ user: USER, policy: POLICY, action: 'dysms:SendSms', sourceIp: 'REDACTED_COMPANY_INFRASTRUCTURE', consoleLogin: false, remoteInput: REMOTE_INPUT, sendsSms: false }));
    return;
  }
  if (!['inspect', 'provision'].includes(mode)) throw new Error('INVALID_ACTION');
  const before = await inspect();
  if (mode === 'inspect') {
    console.log(JSON.stringify({ userExists: Boolean(before.user), policyExists: Boolean(before.policy), existingKeys: before.keyCount }));
    return;
  }
  if (before.keyCount) throw new Error('EXISTING_KEY_REUSE_REQUIRED');
  const { request } = await import('./inspect-app-ecs.mjs');
  if (!before.user) await ram('CreateUser', { UserName: USER, DisplayName: 'Leyanxiu App SMS', Comments: COMMENT });
  if (!before.policy) await ram('CreatePolicy', { PolicyName: POLICY, PolicyDocument: JSON.stringify(smsIdentityPolicy()), Description: COMMENT });
  try { await ram('AttachPolicyToUser', { UserName: USER, PolicyType: 'Custom', PolicyName: POLICY }); }
  catch (error) { if (error.message !== 'EntityAlreadyExists.User.Policy') throw error; }
  const verified = await inspect();
  if (verified.keyCount) throw new Error('EXISTING_KEY_REUSE_REQUIRED');
  const result = await ram('CreateAccessKey', { UserName: USER });
  const key = result.AccessKey;
  if (!key?.AccessKeyId || !key?.AccessKeySecret) throw new Error('KEY_CREATION_UNCONFIRMED');
  try {
    const patch = { SMS_PROVIDER: 'aliyun', SMS_ACCESS_KEY_ID: key.AccessKeyId, SMS_ACCESS_KEY_SECRET: key.AccessKeySecret,
      SMS_SIGN_NAME: '北京亿博华夏商贸', SMS_TEMPLATE_CODE: 'SMS_338925598', SMS_DAILY_LIMIT: 20,
      PRIVACY_POLICY_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/privacy.html', USER_AGREEMENT_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/terms.html' };
    const transfer = await request('SendFile', { 'InstanceId.1': INSTANCE, Name: 'app-sms.json', TargetDir: path.posix.dirname(REMOTE_INPUT),
      ContentType: 'Base64', Content: Buffer.from(JSON.stringify(patch)).toString('base64'), FileMode: '600', Overwrite: 'false' });
    console.log(JSON.stringify({ provisioned: true, user: USER, policy: POLICY, transferId: transfer.InvokeId, remoteInput: REMOTE_INPUT, activated: false, sentSms: false }));
  } catch {
    let deactivated = false;
    try { await ram('UpdateAccessKey', { UserName: USER, UserAccessKeyId: key.AccessKeyId, Status: 'Inactive' }); deactivated = true; } catch { /* report fixed status only */ }
    console.log(JSON.stringify({ provisioned: true, transferConfirmed: false, deactivated, user: USER }));
    throw new Error('PRIVATE_KEY_TRANSFER_UNCONFIRMED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv[2]).catch(error => {
  console.error(JSON.stringify({ error: /^[A-Za-z0-9_.-]+$/.test(error.message) ? error.message : 'SMS_IDENTITY_OPERATION_FAILED' })); process.exitCode = 1;
});
