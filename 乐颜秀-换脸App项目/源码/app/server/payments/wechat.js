import { createPrivateKey, createPublicKey, randomBytes, createHash } from 'node:crypto';
import { Rsa, Formatter, Aes } from 'wechatpay-axios-plugin';

// Protocol reference: https://pay.wechatpay.cn/doc/v3/merchant/4012365342
// Keep merchant credentials exclusively server-side. Unknown platform serials fail closed.
const ORIGIN = 'https://api.mch.weixin.qq.com';
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const requireValue = (condition, code = 'WECHAT_INVALID_INPUT') => { if (!condition) fail(code); };
const cents = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);
export function toWechatOrderId(orderId) {
  if (/^ord_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(orderId)) return orderId.slice(4).replaceAll('-', '');
  requireValue(identifier(orderId));
  return orderId;
}
export function fromWechatOrderId(value) {
  requireValue(identifier(value));
  if (/^[a-f0-9]{32}$/.test(value)) return `ord_${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return value;
}
function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('WECHAT_INVALID_NOTIFY_URL'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'WECHAT_INVALID_NOTIFY_URL');
  return url.href;
}
function parseJson(value) { try { return JSON.parse(value); } catch { fail('WECHAT_INVALID_JSON'); } }

export function createWechatPay({ appId, mchId, merchantSerial, privateKey, apiV3Key, platformKeys, notifyUrl, refundNotifyUrl, fetchImpl = fetch, now = Date.now }) {
  requireValue(typeof appId === 'string' && /^[A-Za-z0-9]{1,32}$/.test(appId), 'WECHAT_CONFIG_APP_ID');
  requireValue(typeof mchId === 'string' && /^\d{1,32}$/.test(mchId), 'WECHAT_CONFIG_MCH_ID');
  requireValue(typeof merchantSerial === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(merchantSerial), 'WECHAT_CONFIG_SERIAL');
  requireValue(typeof apiV3Key === 'string' && Buffer.byteLength(apiV3Key) === 32, 'WECHAT_CONFIG_API_KEY');
  const merchantKey = createPrivateKey(privateKey);
  requireValue(merchantKey.asymmetricKeyType === 'rsa' && merchantKey.asymmetricKeyDetails.modulusLength >= 2048, 'WECHAT_CONFIG_RSA_KEY');
  const trustedKeys = new Map(Object.entries(platformKeys || {}).map(([serial, pem]) => [serial, createPublicKey(pem)]));
  requireValue(trustedKeys.size > 0 && [...trustedKeys.values()].every(key => key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength >= 2048), 'WECHAT_CONFIG_PLATFORM_KEYS');
  const paymentNotifyUrl = httpsUrl(notifyUrl);
  const refundsNotifyUrl = httpsUrl(refundNotifyUrl || notifyUrl);
  const timestamp = () => String(Math.floor(now() / 1000));
  const nonce = () => randomBytes(16).toString('hex');
  const signature = message => Rsa.sign(message, merchantKey);

  function verifyEnvelope(rawBody, inputHeaders) {
    requireValue(typeof rawBody === 'string' && Buffer.byteLength(rawBody) <= 2 * 1024 * 1024, 'WECHAT_INVALID_BODY');
    const headers = new Headers(inputHeaders);
    const time = headers.get('Wechatpay-Timestamp');
    const random = headers.get('Wechatpay-Nonce');
    const serial = headers.get('Wechatpay-Serial');
    const signed = headers.get('Wechatpay-Signature');
    requireValue(time && /^\d{10,12}$/.test(time) && Math.abs(Math.floor(now() / 1000) - Number(time)) <= 300, 'WECHAT_STALE_SIGNATURE');
    requireValue(random && random.length <= 256 && !/[\r\n]/.test(random) && signed && /^[A-Za-z0-9+/]+={0,2}$/.test(signed), 'WECHAT_INVALID_SIGNATURE');
    const key = trustedKeys.get(serial);
    requireValue(key, 'WECHAT_UNKNOWN_PLATFORM_SERIAL');
    requireValue(Rsa.verify(Formatter.response(time, random, rawBody), signed, key), 'WECHAT_INVALID_SIGNATURE');
  }

  async function request(method, path, payload) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const time = timestamp(); const random = nonce();
    const authorization = Formatter.authorization(mchId, random, signature(Formatter.request(method, path, time, random, body)), time, merchantSerial);
    const response = await fetchImpl(`${ORIGIN}${path}`, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization, 'User-Agent': 'Leyanxiu-Payments/1.0' }, ...(body ? { body } : {}), redirect: 'error', signal: AbortSignal.timeout(12000) });
    const raw = await response.text();
    // Signed responses, including errors, must be authenticated before being acted on.
    verifyEnvelope(raw, response.headers);
    const result = raw ? parseJson(raw) : {};
    if (!response.ok) {
      const error = new Error('WECHAT_API_ERROR'); error.code = 'WECHAT_API_ERROR'; error.status = response.status;
      error.providerCode = typeof result.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : 'UNKNOWN';
      throw error;
    }
    return result;
  }

  return {
    async downloadTradeBill(date) {
      requireValue(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)), 'WECHAT_INVALID_BILL_DATE');
      const manifest = await request('GET', `/v3/bill/tradebill?bill_date=${date}&bill_type=ALL`);
      requireValue(manifest.hash_type === 'SHA1' && /^[a-fA-F0-9]{40}$/.test(manifest.hash_value || ''), 'WECHAT_INVALID_BILL_HASH');
      const url = new URL(manifest.download_url);
      requireValue(url.origin===ORIGIN && url.pathname==='/v3/billdownload/file' && !url.username && !url.password && !url.hash, 'WECHAT_INVALID_BILL_URL');
      const path = url.pathname+url.search, time=timestamp(), random=nonce();
      const authorization = Formatter.authorization(mchId,random,signature(Formatter.request('GET',path,time,random,'')),time,merchantSerial);
      const response=await fetchImpl(url.href,{method:'GET',headers:{Authorization:authorization,Accept:'text/plain'},redirect:'error',signal:AbortSignal.timeout(20000)});
      requireValue(response.ok && response.body,'WECHAT_BILL_DOWNLOAD_FAILED');
      const parts=[];let size=0;
      for await(const part of response.body) {size+=part.length; requireValue(size<=20*1024*1024,'WECHAT_BILL_TOO_LARGE');parts.push(part);}
      const bytes=Buffer.concat(parts);
      requireValue(createHash('sha1').update(bytes).digest('hex')===manifest.hash_value.toLowerCase(),'WECHAT_BILL_HASH_MISMATCH');
      return {csv:bytes.toString('utf8'),hash:createHash('sha256').update(bytes).digest('hex'),appId,mchId};
    },
    async createAppOrder({ orderId, amountCents, description }) {
      requireValue(cents(amountCents) && typeof description === 'string' && description.trim() && Buffer.byteLength(description) <= 127);
      const result = await request('POST', '/v3/pay/transactions/app', { appid: appId, mchid: mchId, description, out_trade_no: toWechatOrderId(orderId), notify_url: paymentNotifyUrl, amount: { total: amountCents, currency: 'CNY' } });
      requireValue(typeof result.prepay_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result.prepay_id), 'WECHAT_INVALID_PREPAY');
      const time = timestamp(); const random = nonce();
      return { appid: appId, partnerid: mchId, prepayid: result.prepay_id, package: 'Sign=WXPay', noncestr: random, timestamp: time, sign: signature(`${appId}\n${time}\n${random}\n${result.prepay_id}\n`) };
    },
    queryOrder(orderId) { return request('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(toWechatOrderId(orderId))}?mchid=${mchId}`); },
    closeOrder(orderId) { return request('POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(toWechatOrderId(orderId))}/close`, { mchid: mchId }); },
    async refund({ orderId, refundId, totalCents, refundCents, reason }) {
      requireValue(identifier(refundId) && cents(totalCents) && cents(refundCents) && refundCents <= totalCents);
      requireValue(reason === undefined || (typeof reason === 'string' && Buffer.byteLength(reason) <= 80));
      return request('POST', '/v3/refund/domestic/refunds', { out_trade_no: toWechatOrderId(orderId), out_refund_no: refundId, notify_url: refundsNotifyUrl, ...(reason ? { reason } : {}), amount: { refund: refundCents, total: totalCents, currency: 'CNY' } });
    },
    queryRefund(refundId) { requireValue(identifier(refundId)); return request('GET', `/v3/refund/domestic/refunds/${encodeURIComponent(refundId)}`); },
    verifyNotification(rawBody, headers) {
      verifyEnvelope(rawBody, headers);
      const envelope = parseJson(rawBody);
      requireValue(typeof envelope.id === 'string' && envelope.id.length > 0 && envelope.id.length <= 128 && envelope.resource_type === 'encrypt-resource', 'WECHAT_INVALID_NOTIFICATION');
      requireValue(['TRANSACTION.SUCCESS', 'REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'].includes(envelope.event_type), 'WECHAT_UNSUPPORTED_EVENT');
      const resource = envelope.resource;
      requireValue(resource?.algorithm === 'AEAD_AES_256_GCM' && typeof resource.nonce === 'string' && Buffer.byteLength(resource.nonce) === 12 && typeof resource.associated_data === 'string' && typeof resource.ciphertext === 'string', 'WECHAT_INVALID_RESOURCE');
      const ciphertext = Buffer.from(resource.ciphertext, 'base64');
      requireValue(ciphertext.length > 16, 'WECHAT_INVALID_RESOURCE');
      let decrypted;
      try {
        decrypted = Aes.AesGcm.decrypt(resource.ciphertext, Buffer.from(apiV3Key), resource.nonce, resource.associated_data);
      } catch { fail('WECHAT_DECRYPT_FAILED'); }
      const data = parseJson(decrypted);
      requireValue(data?.mchid === mchId, 'WECHAT_NOTIFICATION_MERCHANT_MISMATCH');
      if (envelope.event_type === 'TRANSACTION.SUCCESS') {
        requireValue(data.appid === appId && data.trade_type === 'APP' && data.trade_state === 'SUCCESS', 'WECHAT_NOTIFICATION_STATE_MISMATCH');
      } else {
        requireValue(data.refund_status === envelope.event_type.slice('REFUND.'.length), 'WECHAT_NOTIFICATION_STATE_MISMATCH');
      }
      return { id: envelope.id, eventType: envelope.event_type, resource: data };
    },
    validateTransaction(resource, { orderId, amountCents }) {
      requireValue(resource?.appid === appId && resource.mchid === mchId && resource.out_trade_no === toWechatOrderId(orderId) && resource.trade_type === 'APP' && resource.amount?.total === amountCents && cents(amountCents) && resource.amount?.currency === 'CNY', 'WECHAT_TRANSACTION_MISMATCH');
      requireValue(resource.trade_state !== 'SUCCESS' || (typeof resource.transaction_id === 'string' && resource.transaction_id.length > 0), 'WECHAT_TRANSACTION_MISMATCH');
      return resource;
    },
    validateRefund(resource, { orderId, refundId, totalCents, refundCents, transactionId }) {
      // Query responses omit mchid; notifications include it. The signed query endpoint is merchant-authenticated.
      // Refund callbacks omit currency (official schema 4012791906); only our CNY-created order can match.
      const validCurrency = resource?.amount?.currency === 'CNY' || (resource?.amount?.currency === undefined && resource?.mchid === mchId && typeof resource?.refund_status === 'string');
      requireValue(resource && (resource.mchid === undefined || resource.mchid === mchId) && resource.out_trade_no === toWechatOrderId(orderId) && resource.out_refund_no === refundId && typeof resource.refund_id === 'string' && resource.refund_id.length > 0 && resource.amount?.total === totalCents && resource.amount?.refund === refundCents && cents(totalCents) && cents(refundCents) && refundCents <= totalCents && validCurrency && (!transactionId || resource.transaction_id === transactionId), 'WECHAT_REFUND_MISMATCH');
      return resource;
    },
  };
}
