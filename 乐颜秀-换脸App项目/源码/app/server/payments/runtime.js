import { store, complianceStoreReadiness } from '../compliance-store.js';
import { connectBillingDatabase } from './database.js';
import { createBillingLedger } from './ledger.js';
import { createPaymentAccounts } from './accounts.js';
import { createSmsSender, smsReadiness } from './sms.js';
import { databaseEvidence } from './evidence.js';
import { createAccountRegistry } from '../accounts/registry.js';

// Never silently copy, discard or combine two money ledgers on a configuration change.
const backend = process.env.BILLING_BACKEND || 'legacy';
if (!['legacy', 'postgres'].includes(backend)) throw new Error('BILLING_BACKEND_INVALID');
export const billingDatabase = backend === 'postgres' ? connectBillingDatabase() : null;
if (billingDatabase) {
  if (store.listOrders().length) throw new Error('LEGACY_ORDERS_REQUIRE_REVIEWED_MIGRATION');
  await billingDatabase.query('SELECT id FROM billing_accounts LIMIT 1');
  if (process.env.WECHAT_PAY_APP_ID && process.env.WECHAT_PAY_MCH_ID) {
    await billingDatabase.transaction('system:merchant-scope',async q=>{
      await q.query('INSERT INTO billing_instance VALUES(1,$1,$2) ON CONFLICT DO NOTHING',[process.env.WECHAT_PAY_APP_ID,process.env.WECHAT_PAY_MCH_ID]);
      const scope=(await q.query('SELECT app_id,merchant_id FROM billing_instance WHERE id=1')).rows[0];
      if(scope.app_id!==process.env.WECHAT_PAY_APP_ID || scope.merchant_id!==process.env.WECHAT_PAY_MCH_ID) throw new Error('BILLING_MERCHANT_SCOPE_MISMATCH');
    });
  }
}
export const billingStore = billingDatabase ? createBillingLedger(billingDatabase) : store;
export const accountRegistry = process.env.APP_LOGIN_ENABLED==='true' && billingDatabase ? createAccountRegistry(billingDatabase,{users:store}) : null;
if(process.env.APP_LOGIN_ENABLED==='true' && !accountRegistry) throw new Error('APP_LOGIN_REQUIRES_POSTGRES');
if(accountRegistry && process.env.RELEASE_CHANNEL!=='android-app') throw new Error('APP_LOGIN_ANDROID_CHANNEL_REQUIRED');
if(accountRegistry) {
  await billingDatabase.query('SELECT device_id,version,expires_at FROM app_login_devices LIMIT 1');
  await billingDatabase.query('SELECT login_user_id,device_version FROM billing_otp LIMIT 1');
  await billingDatabase.query('SELECT provider,subject FROM app_login_identities LIMIT 1');
  await billingDatabase.query('SELECT state,consumed FROM app_login_challenges LIMIT 1');
}
export const paymentAccounts = billingDatabase ? createPaymentAccounts(billingDatabase, {
  secret: process.env.ACCOUNT_OTP_SECRET, sendSms: smsReadiness() ? createSmsSender() : async () => { throw new Error('SMS_NOT_CONFIGURED'); },
  dailyLimit:Number(process.env.SMS_DAILY_LIMIT || 200),
  resolveLogin:accountRegistry ? (...args)=>accountRegistry.phoneLogin(...args) : undefined,
}) : null;
export async function billingStoreReadiness() {
  if (!billingDatabase) return complianceStoreReadiness();
  try {
    await billingDatabase.query('SELECT id FROM billing_accounts LIMIT 1');
    // Backup restoration and identity durability are separate operational acceptance gates.
    const accepted = databaseEvidence();
    const identity = complianceStoreReadiness();
    return { backend, ready: true, transactional: true,
      productionSupported: accepted && identity.ready && identity.productionSupported,
      blockers: accepted ? [] : ['PostgreSQL backup restoration acceptance required'] };
  } catch { return { backend, ready: false, transactional: true, productionSupported: false, blockers: ['billing database unavailable'] }; }
}
