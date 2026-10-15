// Read-only host inspection through the existing Alibaba Cloud Assistant agent.
// Does not install software, restart services, change ingress or print secrets.
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const credentials = dotenv.parse(fs.readFileSync(new URL('../.env', import.meta.url)));
const region = 'cn-hangzhou';
const instanceId = 'REDACTED_COMPANY_CLOUD_INSTANCE';
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export async function request(Action, extra = {}) {
  const params = { AccessKeyId: credentials.ALIYUN_ACCESS_KEY_ID, Action, Format: 'JSON', Version: '2014-05-26', RegionId: region,
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...extra };
  const canonical = Object.keys(params).sort().map(k => `${encode(k)}=${encode(params[k])}`).join('&');
  params.Signature = crypto.createHmac('sha1', `${credentials.ALIYUN_ACCESS_KEY_SECRET}&`).update(`POST&%2F&${encode(canonical)}`).digest('base64');
  const response = await fetch('https://ecs.aliyuncs.com/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok || result.Code) throw new Error(String(result.Code || 'ECS_INSPECTION_FAILED').replace(/[^A-Za-z0-9_.-]/g, ''));
  return result;
}
const script = `#!/bin/sh
uname -sr
df -h / /var/lib
free -m
command -v docker nginx node psql pg_dump || true
apt-cache policy nodejs postgresql docker.io | head -45
systemctl is-active docker nginx postgresql || true
ss -lnt | head -25
if command -v docker >/dev/null; then docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'; fi
for d in /opt/leyanxiu /opt/leyanxiu/server /var/lib/leyanxiu /etc/leyanxiu /var/backups/leyanxiu; do
  if [ -d "$d" ]; then ls -ld "$d"; find "$d" -maxdepth 1 -type f -printf '%f\\n'; fi
done
find /opt /srv /var/www /home /root -maxdepth 4 -type f \\( -name package.json -o -name compose.yml -o -name docker-compose.yml -o -name '*leyanxiu*.service' \\) -printf '%p\\n' 2>/dev/null | head -40
ps -eo comm | sort -u | head -60
python3 - <<'PY'
import os,json
p='/etc/leyanxiu/server.env'
env={}
if os.path.isfile(p):
 for line in open(p):
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.strip().split('=',1); env[k]=v.strip('\\"\\\'')
names=['BILLING_DATABASE_URL','APP_LOGIN_ENABLED','SMS_PROVIDER','SMS_ACCESS_KEY_ID','SMS_ACCESS_KEY_SECRET','SMS_SIGN_NAME','SMS_TEMPLATE_CODE','ACCOUNT_OTP_SECRET','WECHAT_LOGIN_APP_ID','WECHAT_LOGIN_APP_SECRET','PRIVACY_POLICY_URL','USER_AGREEMENT_URL']
print(json.dumps({'envExists':os.path.isfile(p),'configured':{k:bool(env.get(k)) for k in names},'modes':{k:env.get(k) for k in ['DEPLOY_ENV','AUTH_MODE','BILLING_BACKEND','PAYMENT_MODE','COMPLIANCE_BACKEND']}}))
PY
`;
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) try {
  if (process.argv[2]) {
    if (!/^t-[a-zA-Z0-9]+$/.test(process.argv[2])) throw new Error('INVALID_INSPECTION_ID');
    const result = await request('DescribeInvocationResults', { InvokeId: process.argv[2], InstanceId: instanceId, ContentEncoding: 'PlainText' });
    console.log(JSON.stringify({ instanceId, results: result.Invocation?.InvocationResults?.InvocationResult?.map(r => ({ status: r.InvocationStatus, exitCode: r.ExitCode, output: r.Output })) }));
  } else {
    const result = await request('RunCommand', { 'InstanceId.1': instanceId, Type: 'RunShellScript', Name: 'leyanxiu-app-read-only-inspection-20260930', CommandContent: Buffer.from(script).toString('base64'), ContentEncoding: 'Base64', Timeout: '40', KeepCommand: 'false' });
    console.log(JSON.stringify({ instanceId, inspectionId: result.InvokeId }));
  }
} catch (error) { console.error(JSON.stringify({ error: /^[A-Za-z0-9_.-]+$/.test(error.message) ? error.message : 'ECS_INSPECTION_UNCONFIRMED' })); process.exitCode = 1; }
