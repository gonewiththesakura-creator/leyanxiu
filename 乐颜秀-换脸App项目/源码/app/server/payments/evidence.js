import fs from 'node:fs';
import crypto from 'node:crypto';

// Operational attestations are pinned files, not a Boolean that silently claims acceptance.
export function verifiedPaymentEvidence(file, pin, kind, checks, merchantId) {
  try {
    if(!file || !/^[a-f0-9]{64}$/i.test(pin || '')) return false;
    const bytes=fs.readFileSync(file);
    if(bytes.length>1024*1024 || crypto.createHash('sha256').update(bytes).digest('hex')!==pin.toLowerCase()) return false;
    const value=JSON.parse(bytes);
    return value.kind===kind && value.result==='pass' && typeof value.reviewedBy==='string' && Boolean(value.reviewedBy.trim())
      && Number.isFinite(Date.parse(value.testedAt)) && Date.parse(value.testedAt)<=Date.now()
      && checks.every(check=>value.checks?.[check]===true) && (!merchantId || value.merchantId===merchantId);
  } catch {return false;}
}
export function databaseEvidence(env=process.env) {
  return verifiedPaymentEvidence(env.BILLING_ACCEPTANCE_EVIDENCE,env.BILLING_ACCEPTANCE_SHA256,'app-postgres',
    ['parallelConnections','restartPersistence','backupRestore','leastPrivilege','legacyCutoverReviewed']);
}
export function accountEvidence(env=process.env) {
  return verifiedPaymentEvidence(env.APP_LOGIN_ACCEPTANCE_EVIDENCE,env.APP_LOGIN_ACCEPTANCE_SHA256,'app-account',
    ['phoneLogin','sameAccountAfterReinstall','logoutRevocation','accountSwitchIsolation','legacyAccountsReviewed','backupRestore']);
}
export function merchantEvidence(env=process.env) {
  return verifiedPaymentEvidence(env.PAYMENT_ACCEPTANCE_EVIDENCE,env.PAYMENT_ACCEPTANCE_SHA256,'wechat-app',
    ['realPayment','duplicateNotify','refund','lostCallback','dailyBill','nativeReturn','phoneRecovery'],env.WECHAT_PAY_MCH_ID);
}
