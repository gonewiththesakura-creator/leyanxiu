import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createCipheriv } from 'node:crypto';
import { createWechatPay, toWechatOrderId, fromWechatOrderId } from '../payments/wechat.js';

const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = key => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
const now = 1800000000000;
const config = { appId: 'wx1234567890', mchId: '1900000001', merchantSerial: 'ABC123', privateKey: pem(merchant.privateKey), apiV3Key: '12345678901234567890123456789012', platformKeys: { PUB_KEY_ID_123: pem(platform.publicKey) }, notifyUrl: 'https://example.com/api/wechat', refundNotifyUrl: 'https://example.com/api/wechat/refund', now: () => now };
function signed(body, timestamp = '1800000000') {
  return { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': 'response-nonce', 'Wechatpay-Serial': 'PUB_KEY_ID_123', 'Wechatpay-Signature': sign('RSA-SHA256', Buffer.from(`${timestamp}\nresponse-nonce\n${body}\n`), platform.privateKey).toString('base64') };
}
const orderId = 'ord_12345678-1234-1234-1234-123456789abc';
const trade = { appid: config.appId, mchid: config.mchId, out_trade_no: '12345678123412341234123456789abc', transaction_id: '420000123', trade_state: 'SUCCESS', trade_type: 'APP', amount: { total: 990, currency: 'CNY' } };

test('APP prepay signs exact request bytes and returns verifiable native payment signature', async () => {
  const adapter = createWechatPay({ ...config, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/app');
    assert.equal(opts.redirect, 'error');
    const fields = Object.fromEntries([...opts.headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    assert.ok(verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/app\n${fields.timestamp}\n${fields.nonce_str}\n${opts.body}\n`), merchant.publicKey, Buffer.from(fields.signature, 'base64')));
    assert.deepEqual(JSON.parse(opts.body).amount, { total: 990, currency: 'CNY' });
    assert.equal(JSON.parse(opts.body).out_trade_no, trade.out_trade_no);
    const body = JSON.stringify({ prepay_id: 'wx-prepay-123' });
    return new Response(body, { headers: signed(body) });
  } });
  const params = await adapter.createAppOrder({ orderId, amountCents: 990, description: '制作套餐' });
  assert.equal(params.package, 'Sign=WXPay');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${params.appid}\n${params.timestamp}\n${params.noncestr}\n${params.prepayid}\n`), merchant.publicKey, Buffer.from(params.sign, 'base64')));
  assert.equal(fromWechatOrderId(toWechatOrderId(orderId)), orderId);
});

test('unsigned or mismatched signed API responses never issue payment params', async () => {
  for (const headers of [{}, signed('tampered')]) {
    const adapter = createWechatPay({ ...config, fetchImpl: async () => new Response('{"prepay_id":"fake"}', { headers }) });
    await assert.rejects(adapter.createAppOrder({ orderId, amountCents: 990, description: '制作' }), /WECHAT_/);
  }
});

test('notification authenticates original bytes, timestamp and pinned serial before decrypting', () => {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.apiV3Key), Buffer.from('123456789012'));
  cipher.setAAD(Buffer.from('transaction'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(trade)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = JSON.stringify({ id: 'evt1', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', nonce: '123456789012', associated_data: 'transaction', ciphertext } });
  const adapter = createWechatPay(config);
  assert.deepEqual(adapter.verifyNotification(body, signed(body)).resource, trade);
  assert.throws(() => adapter.verifyNotification(body + ' ', signed(body)), /WECHAT_/);
  assert.throws(() => adapter.verifyNotification(body, { ...signed(body), 'Wechatpay-Serial': 'unknown' }), /WECHAT_/);
  assert.throws(() => adapter.verifyNotification(body, signed(body, '1799999000')), /WECHAT_/);
});

test('transaction validation rejects cross merchant/app/order/currency/amount and missing trade ID', () => {
  const adapter = createWechatPay(config);
  adapter.validateTransaction(trade, { orderId, amountCents: 990 });
  for (const delta of [{ appid: 'other' }, { mchid: 'other' }, { out_trade_no: 'other' }, { amount: { total: 1, currency: 'CNY' } }, { amount: { total: 990, currency: 'USD' } }, { transaction_id: '' }, { trade_type: 'JSAPI' }]) {
    assert.throws(() => adapter.validateTransaction({ ...trade, ...delta }, { orderId, amountCents: 990 }), /WECHAT_/);
  }
});

test('query, close and refund use signed correct merchant endpoints and integer cents', async () => {
  const seen = [];
  const adapter = createWechatPay({ ...config, fetchImpl: async (url, opts) => { seen.push([url, opts]); const body = JSON.stringify({ status: 'PROCESSING' }); return new Response(body, { headers: signed(body) }); } });
  await adapter.queryOrder(orderId);
  await adapter.closeOrder(orderId);
  await adapter.refund({ orderId, refundId: 'refund123', totalCents: 990, refundCents: 990, reason: '申请退款' });
  await adapter.queryRefund('refund123');
  assert.ok(seen[0][0].endsWith('/out-trade-no/12345678123412341234123456789abc?mchid=1900000001'));
  assert.deepEqual(JSON.parse(seen[1][1].body), { mchid: config.mchId });
  assert.deepEqual(JSON.parse(seen[2][1].body).amount, { total: 990, refund: 990, currency: 'CNY' });
  assert.ok(seen[3][0].endsWith('/v3/refund/domestic/refunds/refund123'));
  await assert.rejects(adapter.refund({ orderId, refundId: 'refund123', totalCents: 990, refundCents: 991 }), /WECHAT_/);
  await assert.rejects(adapter.createAppOrder({ orderId, amountCents: 0.1, description: 'bad' }), /WECHAT_/);
});

test('refund validation ties notification to merchant, original transaction, order and exact refund', () => {
  const adapter = createWechatPay(config);
  const refund = { mchid: config.mchId, out_trade_no: trade.out_trade_no, out_refund_no: 'refund123', refund_id: 'wxrefund123', transaction_id: trade.transaction_id, refund_status: 'SUCCESS', amount: { total: 990, refund: 990, currency: 'CNY' } };
  const expected = { orderId, refundId: 'refund123', totalCents: 990, refundCents: 990, transactionId: trade.transaction_id };
  adapter.validateRefund(refund, expected);
  adapter.validateRefund({ ...refund, amount: { total: 990, refund: 990, payer_total: 990, payer_refund: 990 } }, expected);
  for (const delta of [{ mchid: 'other' }, { out_refund_no: 'other' }, { transaction_id: 'other' }, { refund_id: '' }, { amount: { total: 990, refund: 1, currency: 'CNY' } }]) assert.throws(() => adapter.validateRefund({ ...refund, ...delta }, expected), /WECHAT_/);
});

test('authenticated but wrong-merchant or inconsistent notification is rejected, including corrupted GCM tag', () => {
  const adapter = createWechatPay(config);
  for (const [value, corrupt] of [[{ ...trade, mchid: 'other' }, false], [{ ...trade, trade_state: 'NOTPAY' }, false], [trade, true]]) {
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.apiV3Key), Buffer.from('123456789012'));
    cipher.setAAD(Buffer.from('transaction'));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
    if (corrupt) bytes[bytes.length - 1] ^= 1;
    const body = JSON.stringify({ id: 'evt1', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', original_type: 'transaction', nonce: '123456789012', associated_data: 'transaction', ciphertext: bytes.toString('base64') } });
    assert.throws(() => adapter.verifyNotification(body, signed(body)), /WECHAT_/);
  }
});
