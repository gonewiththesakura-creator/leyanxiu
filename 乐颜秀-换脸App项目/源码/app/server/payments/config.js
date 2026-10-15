import fs from 'node:fs';
import { createWechatPay } from './wechat.js';
import { parseProducts } from './routes.js';
import { billingStore, paymentAccounts } from './runtime.js';
import { accountEvidence } from './evidence.js';
import { smsReadiness } from './sms.js';
import { merchantEvidence } from './evidence.js';

let cached;
export const products = async () => (await billingStore.paymentProducts()) ?? parseProducts(process.env.PAYMENT_PRODUCTS_JSON);
export function paymentAdapter() {
  if (!cached) cached = createWechatPay({
    appId: process.env.WECHAT_PAY_APP_ID, mchId: process.env.WECHAT_PAY_MCH_ID,
    merchantSerial: process.env.WECHAT_PAY_MERCHANT_SERIAL,
    privateKey: fs.readFileSync(process.env.WECHAT_PAY_PRIVATE_KEY_FILE, 'utf8'),
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY,
    platformKeys: JSON.parse(fs.readFileSync(process.env.WECHAT_PAY_PLATFORM_KEYS_FILE, 'utf8')),
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL,
    refundNotifyUrl: process.env.WECHAT_PAY_REFUND_NOTIFY_URL,
  });
  return cached;
}
export async function paymentReadiness(ledger) {
  const blockers = [...paymentOperationsReadiness(ledger).blockers];
  const merchantTest = process.env.PAYMENT_MODE === 'merchant_test';
  if (!['live', 'merchant_test'].includes(process.env.PAYMENT_MODE)) blockers.push('payment mode is closed');
  if (merchantTest && !String(process.env.PAYMENT_TEST_USER_IDS || '').trim()) blockers.push('merchant test requires explicit user allowlist');
  if (process.env.PAYMENT_PROVIDER !== 'wechat-app') blockers.push('wechat-app provider required');
  if (process.env.RELEASE_CHANNEL !== 'android-app') blockers.push('Android APP payment only');
  if (!(await products()).length) blockers.push('valid company-approved products required');
  if (!merchantTest && billingStore.backend !== 'postgres') blockers.push('PostgreSQL billing ledger required for public paid launch');
  if (!merchantTest && !merchantEvidence()) blockers.push('pinned real merchant payment, refund, recovery and bill acceptance required');
  if (!merchantTest && (process.env.PAYMENT_RECONCILE_ENABLED !== 'true' || process.env.PAYMENT_BILL_RECONCILE_ENABLED !== 'true')) blockers.push('pending-order recovery and daily-bill jobs must be enabled');
  if (!merchantTest && (!paymentAccounts || !smsReadiness() || process.env.ACCOUNT_RECOVERY_VERIFIED !== 'true')) blockers.push('phone recovery configuration and real-device acceptance required');
  if (!merchantTest && process.env.APP_LOGIN_ENABLED!=='true') blockers.push('unified App account login required');
  if (!merchantTest && !accountEvidence()) blockers.push('pinned App login, logout and account-switch real-device acceptance required');
  return { ready: blockers.length === 0, mode: process.env.PAYMENT_MODE || 'closed_test', blockers };
}

export function paymentOperationsReadiness(ledger) {
  const blockers = [];
  if (!ledger.transactional || !ledger.ready || !ledger.productionSupported) blockers.push('transactional durable ledger and backup acceptance required');
  try { paymentAdapter(); } catch { blockers.push('merchant credentials or platform public keys are missing or invalid'); }
  return { ready: blockers.length === 0, blockers };
}
