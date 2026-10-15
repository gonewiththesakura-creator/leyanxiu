// Local operator helper. No phone/code, consent click, SMS, or credential file is created.
// The existing test invitation travels as RSA-OAEP ciphertext in Cloud Assistant output.
import crypto from 'node:crypto';
const args = process.argv.slice(2);
const check = (value, code) => { if (!value) throw new Error(code); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let stage = 'arguments';
try {
  if (!args.length) {
    console.log(JSON.stringify({ mode: 'plan', target: 'MuMu App privacy screen on local CDP 9224', fillsInvitationOnly: true, acceptsConsent: false, sendsSms: false }));
  } else {
    check(args.length === 1 && args[0] === '--apply', 'ARGUMENTS_INVALID');
    stage = 'local-target';
    const response = await fetch('http://127.0.0.1:9224/json', { signal: AbortSignal.timeout(5000) });
    check(response.ok, 'LOCAL_WEBVIEW_UNAVAILABLE');
    const tabs = (await response.json()).filter(tab => tab.type === 'page' && tab.url === 'https://localhost/' && tab.title === '乐颜秀');
    check(tabs.length === 1, 'APP_WEBVIEW_AMBIGUOUS');
    const address = new URL(tabs[0].webSocketDebuggerUrl);
    check(['127.0.0.1', 'localhost'].includes(address.hostname) && address.port === '9224', 'LOCAL_WEBVIEW_TARGET_INVALID');
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('LOCAL_WEBVIEW_UNAVAILABLE')), { once: true }); });
    let sequence = 0;
    const evaluate = expression => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('WEBVIEW_TIMEOUT')); }, 10000);
      function receive(event) {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== id) return;
        clearTimeout(timeout); socket.removeEventListener('message', receive);
        if (message.error || message.result?.exceptionDetails) reject(new Error('WEBVIEW_EVALUATION_FAILED'));
        else resolve(message.result?.result?.value);
      }
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    const preflight = await evaluate(`Boolean(window.Capacitor?.getPlatform()==='android' && document.querySelectorAll('input[placeholder="请输入邀请码"]').length===1 && document.body.innerText.includes('本次仅开放受邀账号测试'))`);
    check(preflight, 'APP_PRIVACY_SCREEN_REQUIRED');
    stage = 'sealed-transfer';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const remote = `#!/bin/sh
set -eu
cd /opt/leyanxiu-app-account/releases/20261009-account
node --input-type=module <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
import {parse} from 'dotenv';
try {
 const env=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 if(env.APP_ACCOUNT_ONLY!=='true'||env.APP_ACCOUNT_OPERATIONS_ENABLED!=='true'||env.CLOSED_TEST_REQUIRE_INVITE!=='true'||env.PAYMENT_MODE!=='closed_test'||!env.CLOSED_TEST_INVITE_SECRET) throw new Error();
 const sealed=crypto.publicEncrypt({key:${JSON.stringify(publicPem)},padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(env.CLOSED_TEST_INVITE_SECRET));
 console.log(JSON.stringify({sealed:sealed.toString('base64')}));
} catch {console.log(JSON.stringify({error:'INVITATION_SEAL_FAILED'}));process.exitCode=1;}
JS`;
    const { request } = await import('./inspect-app-ecs.mjs');
    const invocation = await request('RunCommand', { 'InstanceId.1': 'REDACTED_COMPANY_CLOUD_INSTANCE', Type: 'RunShellScript', Name: 'app-test-invitation-sealed-for-local-webview', CommandContent: Buffer.from(remote).toString('base64'), ContentEncoding: 'Base64', KeepCommand: 'false', Timeout: '30' });
    let sealed;
    for (let attempt = 0; attempt < 20; attempt++) {
      await pause(1500);
      const result = await request('DescribeInvocationResults', { InvokeId: invocation.InvokeId, InstanceId: 'REDACTED_COMPANY_CLOUD_INSTANCE', ContentEncoding: 'PlainText' });
      const item = result.Invocation?.InvocationResults?.InvocationResult?.[0];
      if (!item || ['Pending', 'Running'].includes(item.InvocationStatus)) continue;
      check(item.InvocationStatus === 'Success' && item.ExitCode === 0, 'INVITATION_TRANSFER_FAILED');
      try { sealed = JSON.parse(item.Output).sealed; } catch { throw new Error('INVITATION_ENVELOPE_INVALID'); }
      break;
    }
    check(typeof sealed === 'string', 'INVITATION_TRANSFER_UNCONFIRMED');
    stage = 'local-decryption';
    const invitation = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sealed, 'base64'));
    check(invitation.length >= 16 && invitation.length <= 256, 'INVITATION_FORMAT_INVALID');
    stage = 'masked-prefill';
    check(await evaluate(`Boolean(document.querySelector('input[placeholder="请输入邀请码"]') && document.body.innerText.includes('本次仅开放受邀账号测试'))`), 'APP_SCREEN_CHANGED');
    const filled = await evaluate(`(()=>{const input=document.querySelector('input[placeholder="请输入邀请码"]');input.type='password';Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(invitation.toString('utf8'))});input.dispatchEvent(new Event('input',{bubbles:true}));return input.type==='password'&&input.value.length>0})()`);
    invitation.fill(0);
    check(filled, 'INVITATION_PREFILL_FAILED');
    console.log(JSON.stringify({ invitationPrefilled: true, masked: true, consentAccepted: false, phoneEntered: false, smsSent: false }));
  }
} catch (error) {
  const code = /^[A-Z_]{5,70}$/.test(error?.message || '') ? error.message : 'APP_INVITATION_PREPARATION_FAILED';
  console.error(JSON.stringify({ code, stage }));
  process.exitCode = 1;
} finally { socket?.close(); }
