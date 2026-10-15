// Read-only support diagnostic. Phone stays in process memory and is supplied only
// to the SMS provider already used by this App. Never reads the verification code.
import fs from 'node:fs';
import { parse } from 'dotenv';
import SMS from '@alicloud/dysmsapi20170525';
let socket;
const check = (condition, code) => { if (!condition) throw new Error(code); };
const safeCode = value => /^[A-Za-z0-9_.:-]{1,90}$/.test(String(value || '')) ? String(value) : 'UNKNOWN';
try {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(JSON.stringify({ mode: 'plan', action: 'QuerySendDetails', sendsSms: false, printsPhone: false, readsCode: false }));
  } else {
    check(args.length === 1 && args[0] === '--query', 'INVALID_ARGUMENTS');
    const tabs = await (await fetch('http://127.0.0.1:9224/json', { signal: AbortSignal.timeout(5000) })).json();
    const target = tabs.filter(tab => tab.type === 'page' && tab.title === '乐颜秀' && tab.url === 'https://localhost/');
    check(target.length === 1, 'APP_TARGET_REQUIRED');
    const address = new URL(target[0].webSocketDebuggerUrl);
    check(['127.0.0.1', 'localhost'].includes(address.hostname) && address.port === '9224', 'LOCAL_TARGET_REQUIRED');
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WEBVIEW_TIMEOUT')), 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WEBVIEW_FAILED')); }, { once: true });
    });
    let phone = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WEBVIEW_TIMEOUT')), 10000);
      socket.addEventListener('message', event => {
        let result;
        try { result = JSON.parse(event.data); } catch { return; }
        if (result.id !== 1) return;
        clearTimeout(timer);
        if (result.error || result.result?.exceptionDetails) reject(new Error('PHONE_INPUT_UNAVAILABLE'));
        else resolve(result.result?.result?.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `window.Capacitor?.getPlatform()==='android'&&document.querySelectorAll('input[aria-label="登录手机号"]').length===1?document.querySelector('input[aria-label="登录手机号"]').value:null`, returnByValue: true,
      } }));
    });
    check(typeof phone === 'string' && /^1[3-9][0-9]{9}$/.test(phone), 'PHONE_INPUT_UNAVAILABLE');
    const env = parse(fs.readFileSync(new URL('../.env', import.meta.url)));
    const client = new SMS.default({ accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
      endpoint: 'dysmsapi.aliyuncs.com', protocol: 'HTTPS', connectTimeout: 5000, readTimeout: 10000 });
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type).value;
    const sendDate = part('year') + part('month') + part('day');
    const result = await client.querySendDetails(new SMS.QuerySendDetailsRequest({ phoneNumber: phone, sendDate, pageSize: 10, currentPage: 1 }));
    phone = undefined;
    check(result.body?.code === 'OK', 'SMS_RECEIPT_QUERY_FAILED');
    const rows = result.body.smsSendDetailDTOs?.smsSendDetailDTO || [];
    const time = value => /^[0-9 :-]{10,25}$/.test(value || '') ? value : null;
    console.log(JSON.stringify({ code: 'SMS_RECEIPTS_READ', sendsSms: false,
      rows: rows.map(row => ({ status: [1, 2, 3].includes(row.sendStatus) ? row.sendStatus : null,
        errorCode: safeCode(row.errCode), sendTime: time(row.sendDate), receiveTime: time(row.receiveDate) })) }));
  }
} catch (error) {
  console.error(JSON.stringify({ code: safeCode(error?.code || error?.message) }));
  process.exitCode = 1;
} finally { socket?.close(); }
