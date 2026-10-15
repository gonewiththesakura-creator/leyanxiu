import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const moduleUrl = new URL('../compliance-sqlite.js', import.meta.url);
const storeUrl = new URL('../compliance-store.js', import.meta.url);
function child(code, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; p.stdout.on('data', x => output += x); p.stderr.on('data', x => output += x);
    p.on('error', reject); p.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
test('sqlite reopens committed state and rolls back failed mutations', async () => {
  const { createComplianceSqlite } = await import(moduleUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-sqlite-'));
  const filename = path.join(dir, 'ledger.db');
  const db = createComplianceSqlite(filename, () => ({ schemaVersion: 1, count: 0 }));
  db.transact(state => { state.count += 1; return { state, result: state.count }; });
  assert.throws(() => db.transact(state => { state.count = 99; throw new Error('abort'); }), /abort/);
  assert.equal(db.transact(state => ({ state, result: state.count })), 1);
  db.close();
  const reopened = createComplianceSqlite(filename, () => ({ schemaVersion: 1, count: 0 }));
  assert.equal(reopened.transact(state => ({ state, result: state.count })), 1);
  reopened.close();
  fs.rmSync(dir, { recursive: true });
});
test('store rolls back partial mutations and nested account deletion commits together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-sqlite-rollback-'));
  const env = { COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: path.join(dir, 'ledger.db'), DATA_DIR: dir, DEPLOY_ENV: 'test' };
  await child(`
    import assert from 'node:assert/strict';
    const {store,resetStoreForTests}=await import(${JSON.stringify(storeUrl.href)});
    const user=store.createOrGetUser({subject:'rollback'});
    const evidence={}; evidence.self=evidence;
    assert.throws(()=>store.recordConsent({userId:user.id,consentType:'privacy',version:'v1',action:'granted',evidence}));
    assert.equal(store.listConsents(user.id).length,0);
    store.createSession({userId:user.id,tokenHash:'hash',sessionId:'test',expiresAt:'2099-01-01'});
    store.markUserDeleted(user.id);
    assert.equal(store.findSession('test'),null);
    assert.equal(store.snapshot().sessions[0].revokeReason,'account_deleted');
    resetStoreForTests();
    assert.equal(store.snapshot().users.length,0);
  `, env);
  fs.rmSync(dir, { recursive: true });
});
test('multiple server processes retain all users and idempotent orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-sqlite-process-'));
  const env = { COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: path.join(dir, 'ledger.db'), DATA_DIR: dir, DEPLOY_ENV: 'test' };
  const outputs = await Promise.all(Array.from({ length: 4 }, (_, worker) => child(`
    const {store, complianceStoreReadiness} = await import(${JSON.stringify(storeUrl.href)});
    for (let i=0;i<20;i++) {
      const user=store.createOrGetUser({subject:'shared-'+i});
      const {order}=store.createOrder({userId:user.id,productId:'pack',amountFen:100,credits:1,channel:'wechat',idempotencyKey:'shared-order-'+i});
      store.applyPaymentEvent({eventId:'payment-${worker}-'+i,orderId:order.id,status:'paid',providerTradeId:'trade-'+i,rawDigest:'a'.repeat(64)});
      if (store.entitlements(user.id).purchasedRemaining!==1) throw new Error('duplicate grant');
      store.createOrGetUser({subject:'worker-${worker}-'+i});
    }
    console.log(complianceStoreReadiness().backend);
  `, env)));
  assert.ok(outputs.every(value => value.includes('sqlite')));
  const snapshot = await child(`const {store}=await import(${JSON.stringify(storeUrl.href)}); console.log(JSON.stringify(store.snapshot()));`, env);
  const result = JSON.parse(snapshot.trim());
  assert.equal(result.users.length, 100);
  assert.equal(result.orderCount, 20);
  assert.equal(result.ledgerCount, 20);
  fs.rmSync(dir, { recursive: true });
});
