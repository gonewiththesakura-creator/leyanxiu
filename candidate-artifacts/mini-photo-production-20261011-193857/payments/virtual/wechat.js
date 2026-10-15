import crypto from 'node:crypto';

const equal = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
export const paySignature = (key, uri, body) => crypto.createHmac('sha256', key).update(`${uri}&${body}`).digest('hex');
export const userSignature = (key, body) => crypto.createHmac('sha256', key).update(body).digest('hex');
const sha1 = values => crypto.createHash('sha1').update(values.sort().join('')).digest('hex');

// Only JSON + safe mode is supported. A plaintext token signature does not authenticate a body.
export function createMessageCodec({ appId, token, aesKey, now = Date.now }) {
  if (!appId || !token || !/^[A-Za-z0-9+/]{43}$/.test(aesKey || '')) throw new Error('XPAY_MESSAGE_CONFIG_REQUIRED');
  const key = Buffer.from(`${aesKey}=`, 'base64');
  const checkTime = timestamp => {
    if (!/^\d{10}$/.test(String(timestamp)) || Math.abs(now() / 1000 - Number(timestamp)) > 300) throw new Error('XPAY_MESSAGE_EXPIRED');
  };
  return {
    verifyUrl(query) {
      checkTime(query.timestamp);
      if (!query.nonce || !equal(query.signature, sha1([token, query.timestamp, query.nonce]))) throw new Error('XPAY_MESSAGE_SIGNATURE');
      if (typeof query.echostr !== 'string' || query.echostr.length > 1024) throw new Error('XPAY_MESSAGE_INVALID');
      return query.echostr;
    },
    decode(body, query) {
      checkTime(query.timestamp);
      if (query.encrypt_type !== 'aes' || !query.nonce || typeof body?.Encrypt !== 'string' || body.Encrypt.length > 128 * 1024
        || !equal(query.msg_signature, sha1([token, query.timestamp, query.nonce, body.Encrypt]))) throw new Error('XPAY_MESSAGE_SIGNATURE');
      const encrypted = Buffer.from(body.Encrypt, 'base64');
      if (!encrypted.length || encrypted.length % 16) throw new Error('XPAY_MESSAGE_INVALID');
      const cipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
      const padded = Buffer.concat([cipher.update(encrypted), cipher.final()]);
      const pad = padded.at(-1);
      if (pad < 1 || pad > 32 || !padded.subarray(-pad).every(x => x === pad)) throw new Error('XPAY_MESSAGE_PADDING');
      const plain = padded.subarray(0, -pad);
      if (plain.length < 20) throw new Error('XPAY_MESSAGE_INVALID');
      const length = plain.readUInt32BE(16);
      if (20 + length > plain.length || !equal(plain.subarray(20 + length).toString(), appId)) throw new Error('XPAY_MESSAGE_APPID');
      return JSON.parse(plain.subarray(20, 20 + length).toString('utf8'));
    },
    encode(value, nonce = crypto.randomBytes(12).toString('hex')) {
      const message = Buffer.from(JSON.stringify(value)); const length = Buffer.alloc(4); length.writeUInt32BE(message.length);
      const plain = Buffer.concat([crypto.randomBytes(16), length, message, Buffer.from(appId)]);
      const pad = 32 - plain.length % 32;
      const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
      const Encrypt = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
      const TimeStamp = Math.floor(now() / 1000);
      return { Encrypt, TimeStamp, Nonce: nonce, MsgSignature: sha1([token, String(TimeStamp), nonce, Encrypt]) };
    },
  };
}

export function createVirtualWechat({ appId, appSecret, offerId, appKey, env, fetchImpl = fetch, now = Date.now }) {
  if (!appId || !appSecret || !offerId || !appKey || ![0, 1].includes(env)) throw new Error('XPAY_CONFIG_REQUIRED');
  let token; let tokenUntil = 0; let tokenRequest;
  async function jsonRequest(url, body) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(10000), redirect: 'error' });
    } catch { throw new Error('XPAY_NETWORK_UNCONFIRMED'); }
    if (!response.ok) throw new Error('XPAY_HTTP_UNCONFIRMED');
    const data = await response.json();
    if (data.errcode && data.errcode !== 0) {
      const error = new Error('XPAY_PROVIDER_ERROR'); error.providerCode = data.errcode; throw error;
    }
    return data;
  }
  async function accessToken() {
    if (token && now() < tokenUntil) return token;
    if (!tokenRequest) tokenRequest = (async () => {
      const data = await jsonRequest('https://api.weixin.qq.com/cgi-bin/stable_token', JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: false }));
      if (!data.access_token || !Number.isFinite(data.expires_in) || data.expires_in < 120) throw new Error('XPAY_TOKEN_INVALID');
      token = data.access_token; tokenUntil = now() + (data.expires_in - 120) * 1000; return token;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }
  async function call(uri, payload, retry = true) {
    const body = JSON.stringify({ ...payload, env });
    const query = new URLSearchParams({ access_token: await accessToken(), pay_sig: paySignature(appKey, uri, body) });
    try { return await jsonRequest(`https://api.weixin.qq.com${uri}?${query}`, body); }
    catch (error) {
      // A definite invalid-token rejection is safe to retry; a timeout never is.
      if (retry && [40001, 40014, 42001].includes(error.providerCode)) { tokenUntil = 0; return call(uri, payload, false); }
      throw error;
    }
  }
  return {
    appId, env,
    paymentArgs(order, sessionKey) {
      if (order.appId !== appId || order.env !== env || !sessionKey) throw new Error('XPAY_IDENTITY_MISMATCH');
      const signData = JSON.stringify({ offerId, buyQuantity: 1, env, currencyType: 'CNY', productId: order.productId,
        goodsPrice: order.amountFen, outTradeNo: order.id, attach: order.id });
      return { mode: 'short_series_goods', signData, paySig: paySignature(appKey, 'requestVirtualPayment', signData), signature: userSignature(sessionKey, signData) };
    },
    query: order => call('/xpay/query_order', { openid: order.openid, order_id: order.id }),
    deliver: order => call('/xpay/notify_provide_goods', { order_id: order.id }),
    refund: (order, refund) => call('/xpay/refund_order', { openid: order.openid, order_id: order.id,
      refund_order_id: refund.id, left_fee: order.amountFen - order.refundedFen, refund_fee: refund.amountFen,
      biz_meta: refund.id, refund_reason: '2', req_from: refund.requestSource === 'user' ? '2' : '1' }),
    queryRefund: (order, refund) => call('/xpay/query_order', { openid: order.openid, order_id: refund.id }),
    downloadBill: (begin, end) => call('/xpay/download_bill', { begin_ds: begin, end_ds: end }),
    downloadIosBill: (begin, end) => call('/xpay/download_ios_settlement_bill', { start_month: begin, end_month: end }),
  };
}

export function validatePaidOrder(remote, local) {
  if (!remote || remote.order_id !== local.id || remote.env_type !== local.env + 1
    || remote.order_fee !== local.amountFen || remote.paid_fee !== local.amountFen
    || ![0, 7].includes(remote.order_type) || ![2, 3, 4].includes(remote.status)
    || !remote.wx_order_id || !Number.isSafeInteger(remote.paid_time) || remote.paid_time <= 0
    || remote.left_fee !== local.amountFen) throw new Error('XPAY_ORDER_MISMATCH');
  return remote;
}

export function validateDelivery(message, order) {
  const goods = message.GoodsInfo;
  if (message.MsgType !== 'event' || message.Event !== 'xpay_goods_deliver_notify' || message.OpenId !== order.openid
    || message.OutTradeNo !== order.id || message.Env !== order.env || goods?.ProductId !== order.productId
    || goods.Quantity !== 1 || goods.OrigPrice !== order.amountFen || goods.ActualPrice !== order.amountFen
    || goods.Attach !== order.id) throw new Error('XPAY_DELIVERY_MISMATCH');
}
