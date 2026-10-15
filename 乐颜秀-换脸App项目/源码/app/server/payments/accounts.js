import crypto from 'node:crypto';

export function createPaymentAccounts(db, { secret, sendSms, now = Date.now, dailyLimit = 200, resolveLogin }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('ACCOUNT_OTP_SECRET_REQUIRED');
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit<1 || dailyLimit>10000) throw new Error('SMS_BUDGET_INVALID');
  const digest = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const failure = code => ({ error: code });
  return {
    async status(userId) {
      const row = (await db.query('SELECT masked FROM billing_phones WHERE user_id=$1', [userId])).rows[0];
      return { bound: Boolean(row), maskedPhone: row?.masked || null };
    },
    async deviceAccount(deviceUserId) {
      const row = (await db.query('SELECT user_id,disabled FROM billing_devices WHERE device_user_id=$1', [deviceUserId])).rows[0];
      return row?.disabled ? null : row?.user_id || deviceUserId;
    },
    async challenge({ phone, purpose, deviceUserId, ip, loginUserId, deviceVersion }) {
      if (!/^1[3-9][0-9]{9}$/.test(phone || '') || !['bind','recover', ...(resolveLogin ? ['login','link-phone'] : [])].includes(purpose) || !deviceUserId) return failure('INVALID_PHONE_REQUEST');
      if(purpose==='link-phone' && (!loginUserId || !deviceVersion)) return failure('INVALID_PHONE_REQUEST');
      const phoneHash = digest(`phone:${phone}`); const ipHash = digest(`ip:${ip}`);
      const id = crypto.randomUUID(); const code = String(crypto.randomInt(0, 1000000)).padStart(6,'0');
      const result = await db.transaction('system:sms-limit', async q => {
        await q.query('DELETE FROM billing_otp WHERE created_at<$1', [now()-86400000]);
        if(Number((await q.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n)>=dailyLimit) return failure('SMS_RATE_LIMIT');
        const rows = (await q.query('SELECT phone_hash,ip_hash,device_user_id,created_at FROM billing_otp WHERE phone_hash=$1 OR ip_hash=$2 OR device_user_id=$3', [phoneHash,ipHash,deviceUserId])).rows;
        if (rows.filter(r=>r.phone_hash===phoneHash).length >= 5 || rows.filter(r=>r.ip_hash===ipHash).length >= 20 || rows.filter(r=>r.device_user_id===deviceUserId).length >= 10
          || rows.some(r=>(r.phone_hash===phoneHash || r.device_user_id===deviceUserId) && Number(r.created_at)>now()-60000)) return failure('SMS_RATE_LIMIT');
        // Keep responses uniform: no phone-account enumeration through the send endpoint.
        await q.query('INSERT INTO billing_otp(id,phone_hash,masked,device_user_id,purpose,code_hash,ip_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [id,phoneHash,`${phone.slice(0,3)}****${phone.slice(-4)}`,deviceUserId,purpose,digest(`${id}:${code}`),ipHash,now()]);
        if(loginUserId) await q.query('UPDATE billing_otp SET login_user_id=$2,device_version=$3 WHERE id=$1',[id,loginUserId,deviceVersion || null]);
        return { challengeId: id, expiresIn: 300 };
      });
      if (result.error) return result;
      try {
        await sendSms(phone, code);
        await db.query('UPDATE billing_otp SET sent=true WHERE id=$1', [id]);
        return result;
      } catch {
        await db.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE id=$1", [id]);
        return failure('SMS_DELIVERY_UNCONFIRMED');
      }
    },
    async verify({ challengeId, code, deviceUserId, expectedPurpose }) {
      // Serialize identity changes across accounts. Never auto-merge paid accounts.
      return db.transaction('system:account-binding', async q => {
        const item = (await q.query('SELECT * FROM billing_otp WHERE id=$1 FOR UPDATE', [challengeId])).rows[0];
        if (item && (item.consumed || item.attempts>=5 || Number(item.created_at)+300000<=now())) {
          await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE id=$1", [challengeId]);
          return failure('OTP_INVALID');
        }
        if (!item || (expectedPurpose && ![].concat(expectedPurpose).includes(item.purpose)) || item.device_user_id!==deviceUserId || item.consumed || !item.sent || item.attempts>=5 || Number(item.created_at)+300000<=now()) return failure('OTP_INVALID');
        await q.query('UPDATE billing_otp SET attempts=attempts+1 WHERE id=$1', [challengeId]);
        const actual = digest(`${challengeId}:${String(code || '')}`);
        if (!/^[0-9a-f]{64}$/.test(item.code_hash || '') || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(item.code_hash))) {
          if (item.attempts+1>=5 || !/^[0-9a-f]{64}$/.test(item.code_hash || '')) await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE id=$1", [challengeId]);
          return failure('OTP_INVALID');
        }
        await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE id=$1", [challengeId]);
        if (['login','link-phone'].includes(item.purpose)) return resolveLogin(q, item, deviceUserId);
        const phone = (await q.query('SELECT user_id FROM billing_phones WHERE phone_hash=$1', [item.phone_hash])).rows[0];
        const bound = (await q.query('SELECT phone_hash FROM billing_phones WHERE user_id=$1', [deviceUserId])).rows[0];
        await q.query('INSERT INTO billing_accounts(id) VALUES($1) ON CONFLICT DO NOTHING', [deviceUserId]);
        let userId = deviceUserId;
        if (item.purpose==='bind') {
          if ((phone && phone.user_id!==deviceUserId) || (bound && bound.phone_hash!==item.phone_hash)) return failure('PHONE_BINDING_CONFLICT');
          await q.query('INSERT INTO billing_phones VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [item.phone_hash,deviceUserId,item.masked]);
        } else {
          if (!phone) return failure('RECOVERY_ACCOUNT_NOT_FOUND');
          userId = phone.user_id;
          if (userId!==deviceUserId) {
            const paid = (await q.query("SELECT id FROM billing_orders WHERE user_id=$1 AND (payload->>'fulfilledAt' IS NOT NULL OR payload->>'status'='pending') LIMIT 1", [deviceUserId])).rows[0];
            if (paid || bound) return failure('ACCOUNT_MERGE_REQUIRES_SUPPORT');
          }
        }
        await q.query('INSERT INTO billing_devices(device_user_id,user_id) VALUES($1,$2) ON CONFLICT(device_user_id) DO UPDATE SET user_id=$2,disabled=false', [deviceUserId,userId]);
        await q.query('INSERT INTO billing_audit VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),userId,`account.${item.purpose}`,JSON.stringify({ deviceUserId, maskedPhone:item.masked }),now()]);
        return { userId, recovered:item.purpose==='recover' };
      });
    },
  };
}
