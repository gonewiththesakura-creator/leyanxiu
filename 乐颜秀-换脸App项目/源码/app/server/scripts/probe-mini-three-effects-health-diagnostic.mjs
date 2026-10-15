// One diagnostic GET only; never signs in or invokes any business mutation.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateProbeConfig } from './probe-mini-closed-client.mjs';
import { privateRead, privateCreate, evaluateOfficialProbe } from './probe-mini-merchant-identity.mjs';

export function startHealthDiagnostic(config) {
  const slot = '__lyxThreeEffectsHealthDiagnostic20261015';
  if (globalThis[slot]) return { healthDiagnosticVersion: 1, alreadyStarted: true };
  const report = { healthDiagnosticVersion: 1, pending: true, calls: 0, runtimeMatched: false,
    phase: 'runtime', status: 0, ok: false, env0Merchant: false, errorCode: null, failure: '' };
  globalThis[slot] = { nonce: config.nonce, report };
  void (async () => {
    let timer;
    try {
      const app = getApp(), account = wx.getAccountInfoSync(), pages = getCurrentPages();
      if (account?.miniProgram?.appId !== config.target.appId
        || pages[pages.length - 1]?.route !== 'pages/refund-ops/index'
        || app?.globalData?.apiTransport?.env !== config.target.envId
        || app.globalData.apiTransport.service !== config.target.serviceName) {
        report.failure = 'runtime_mismatch'; return;
      }
      report.runtimeMatched = true; report.phase = 'call'; report.calls++;
      const pending = wx.cloud.callContainer({ config: { env: config.target.envId },
        path: '/health?' + encodeURIComponent(config.gray.key) + '=' + encodeURIComponent(config.gray.value),
        method: 'GET', timeout: 20000, header: { 'X-WX-SERVICE': config.target.serviceName } });
      report.phase = 'await';
      const response = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject({ errMsg: 'diagnostic timeout' }), 24000);
      })]);
      report.phase = 'response';
      report.status = Number.isInteger(response?.statusCode) ? response.statusCode : 0;
      let body = response?.data;
      if (typeof body === 'string' && body.length < 65536) body = JSON.parse(body);
      report.ok = report.status === 200 && body?.ok === true && body.service === 'mini-photo-production';
      report.env0Merchant = body?.env === 0 && body?.mode === 'merchant_test';
      if (!report.ok) report.failure = 'http_response';
    } catch (error) {
      const text = String(error?.errMsg || error?.message || '').toLowerCase();
      const code = Number(error?.errCode);
      if (Number.isSafeInteger(code) && Math.abs(code) < 2147483648) report.errorCode = code;
      report.failure = /privacy|隐私/.test(text) ? 'privacy_authorization'
        : /timeout|timed out|超时/.test(text) ? 'transport_timeout'
          : /permission|authorize|unauthorized|权限|授权/.test(text) ? 'transport_permission'
            : /login|登录/.test(text) ? 'transport_login'
              : /network|connect|网络/.test(text) ? 'transport_network'
                : /init|初始化/.test(text) ? 'cloud_initialization' : 'transport_rejected';
    } finally { clearTimeout(timer); report.pending = false; }
  })();
  return { healthDiagnosticVersion: 1, pending: true };
}
export function pollHealthDiagnostic(nonce) {
  const state = globalThis.__lyxThreeEffectsHealthDiagnostic20261015;
  return state?.nonce === nonce ? state.report : { healthDiagnosticVersion: 1, missing: true };
}

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(app, 'server/.env.mini-three-effects-health-diagnostic-20261015.json');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--start', '--poll'].includes(args[0])) throw Error('DIAGNOSTIC_ARGUMENT');
    let attempt;
    if (args[0] === '--start') {
      const route = validateProbeConfig(privateRead(path.join(app, 'server/.env.mini-merchant-three-effects-probe-20261015.json')));
      attempt = { nonce: crypto.randomBytes(16).toString('hex'), project: path.join(app, 'output/mini-native-identity-runtime-20261013') };
      privateCreate(output + '.attempt.json', attempt);
      privateCreate(output + '.args.json', [{ ...route, nonce: attempt.nonce }]);
      console.log(JSON.stringify(await evaluateOfficialProbe(attempt.project, startHealthDiagnostic, output + '.args.json', 'healthDiagnosticVersion')));
    } else {
      attempt = privateRead(output + '.attempt.json');
      const poll = output + '.poll-' + crypto.randomBytes(4).toString('hex') + '.json';
      privateCreate(poll, [attempt.nonce]);
      const result = await evaluateOfficialProbe(attempt.project, pollHealthDiagnostic, poll, 'healthDiagnosticVersion');
      if (result.pending === false) privateCreate(output, result);
      console.log(JSON.stringify(result));
    }
  } catch { console.error('HEALTH_DIAGNOSTIC_UNCONFIRMED'); process.exitCode = 1; }
}
