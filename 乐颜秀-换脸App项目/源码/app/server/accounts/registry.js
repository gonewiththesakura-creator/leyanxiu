import crypto from 'node:crypto';

const MONTH = 30 * 86400000;
// The business user ID survives provider changes. Provider IDs never replace ledger IDs.
export function createAccountRegistry(db, { users, now = Date.now }) {
  const fail = error => ({ error });
  async function attach(q, deviceId, userId) {
    if (!users.getUser(userId) || users.getUser(userId).status !== 'active') return fail('ACCOUNT_UNAVAILABLE');
    // An old guest token must not become valid again when this mapping is later cleared.
    users.revokeUserSessions(deviceId,'account_login');
    const version = crypto.randomUUID();
    await q.query('UPDATE app_login_challenges SET consumed=true WHERE device_id=$1',[deviceId]);
    await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE device_user_id=$1",[deviceId]);
    await q.query('INSERT INTO app_login_devices VALUES($1,$2,$3,$4) ON CONFLICT(device_id) DO UPDATE SET user_id=$2,version=$3,expires_at=$4', [deviceId,userId,version,now()+MONTH]);
    await q.query('INSERT INTO billing_audit VALUES($1,$2,$3,$4,$5)', [crypto.randomUUID(),userId,'account.login',JSON.stringify({deviceId,termsVersion:'account-v1'}),now()]);
    return { userId, deviceId, deviceVersion:version };
  }
  async function newUser(q, subject) {
    const user = users.createOrGetUser({subject,channel:'android',authMethod:'account'});
    await q.query('INSERT INTO billing_accounts(id) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
    return user.id;
  }
  return {
    async phoneLogin(q, item, deviceId) {
      if(item.login_user_id) {
        const device=(await q.query('SELECT * FROM app_login_devices WHERE device_id=$1',[deviceId])).rows[0];
        const active=device?.user_id && Number(device.expires_at)>now();
        if((active ? device.user_id : deviceId)!==item.login_user_id || (active ? device.version : null)!==item.device_version) return fail('LOGIN_STATE_INVALID');
      }
      const phone = (await q.query('SELECT user_id FROM billing_phones WHERE phone_hash=$1',[item.phone_hash])).rows[0];
      if(item.purpose==='link-phone') {
        const device=(await q.query('SELECT * FROM app_login_devices WHERE device_id=$1',[deviceId])).rows[0];
        if(!device || device.user_id!==item.login_user_id || device.version!==item.device_version || Number(device.expires_at)<=now()) return fail('LOGIN_STATE_INVALID');
        const bound=(await q.query('SELECT phone_hash FROM billing_phones WHERE user_id=$1',[item.login_user_id])).rows[0];
        if((phone && phone.user_id!==item.login_user_id) || (bound && bound.phone_hash!==item.phone_hash)) return fail('ACCOUNT_LINK_CONFLICT');
      }
      const userId = item.purpose==='link-phone' ? item.login_user_id : phone?.user_id || await newUser(q,`app-account:phone:${item.phone_hash}`);
      if (!phone) await q.query('INSERT INTO billing_phones VALUES($1,$2,$3)',[item.phone_hash,userId,item.masked]);
      return attach(q,deviceId,userId);
    },
    async device(deviceId) {
      const row = (await db.query('SELECT * FROM app_login_devices WHERE device_id=$1',[deviceId])).rows[0];
      return row?.user_id && Number(row.expires_at)>now() ? { userId:row.user_id,deviceId,deviceVersion:row.version } : {userId:deviceId,deviceId,deviceVersion:null};
    },
    async validSession(auth) {
      if (!auth.deviceId) return false;
      const bound = await this.device(auth.deviceId);
      return bound.userId===auth.userId && bound.deviceVersion===auth.deviceVersion;
    },
    async logout(auth, all=false) {
      return db.transaction('system:account-binding',async q=> {
        const devices=all ? (await q.query('SELECT device_id FROM app_login_devices WHERE user_id=$1',[auth.userId])).rows.map(row=>row.device_id) : [auth.deviceId];
        for(const deviceId of devices) {
          await q.query('UPDATE app_login_challenges SET consumed=true WHERE device_id=$1',[deviceId]);
          await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE device_user_id=$1",[deviceId]);
        }
        // An unbound device may already hold a login code for this account.
        // Logout-all revokes that pending authorization too, keeping its row
        // so signing out never restores the 24-hour SMS allowance.
        if(all) await q.query("UPDATE billing_otp SET consumed=true,code_hash='' WHERE phone_hash IN (SELECT phone_hash FROM billing_phones WHERE user_id=$1)",[auth.userId]);
        if (all) await q.query('UPDATE app_login_devices SET user_id=NULL,version=$2,expires_at=0 WHERE user_id=$1',[auth.userId,crypto.randomUUID()]);
        else await q.query('UPDATE app_login_devices SET user_id=NULL,version=$3,expires_at=0 WHERE device_id=$1 AND user_id=$2',[auth.deviceId,auth.userId,crypto.randomUUID()]);
      });
    },
    async status(userId) {
      const phone=(await db.query('SELECT masked FROM billing_phones WHERE user_id=$1',[userId])).rows[0];
      const identities=(await db.query('SELECT provider FROM app_login_identities WHERE user_id=$1',[userId])).rows;
      return {userId,loggedIn:Boolean(phone || identities.length),bound:Boolean(phone || identities.length),maskedPhone:phone?.masked || null,wechatLinked:identities.some(r=>r.provider.startsWith('wechat-app:'))};
    },
    async deleteIdentity(userId,removeUser) {
      return db.transaction('system:account-binding',async q=> {
        await q.query('UPDATE app_login_challenges SET consumed=true WHERE user_id=$1',[userId]);
        // Retain the 24-hour anti-abuse counters; deletion must not reset the SMS budget.
        await q.query("UPDATE billing_otp SET consumed=true,code_hash='',masked='',login_user_id=NULL,device_version=NULL WHERE login_user_id=$1 OR phone_hash IN (SELECT phone_hash FROM billing_phones WHERE user_id=$1)",[userId]);
        await q.query('DELETE FROM billing_phones WHERE user_id=$1',[userId]);
        await q.query('DELETE FROM app_login_identities WHERE user_id=$1',[userId]);
        await q.query('UPDATE app_login_devices SET user_id=NULL,version=$2,expires_at=0 WHERE user_id=$1',[userId,crypto.randomUUID()]);
        await q.query('UPDATE billing_devices SET disabled=true WHERE user_id=$1',[userId]);
        // Keep financial records on their original user ID. New registration never inherits them.
        await removeUser();
      });
    },
    async startWechat(auth,purpose) {
      if (!['login','link'].includes(purpose)) return fail('INVALID_LOGIN_REQUEST');
      if (purpose==='link' && (auth.authMethod!=='phone' || !Number.isFinite(auth.authenticatedAt) || now()-auth.authenticatedAt>300000)) return fail('RECENT_PHONE_LOGIN_REQUIRED');
      return db.transaction('system:account-binding',async q=> {
        await q.query('DELETE FROM app_login_challenges WHERE expires_at<$1',[now()]);
        const count=(await q.query('SELECT COUNT(*) AS n FROM app_login_challenges WHERE device_id=$1',[auth.deviceId])).rows[0];
        if(Number(count.n)>=5) return fail('LOGIN_RATE_LIMIT');
        const state=crypto.randomBytes(24).toString('hex');
        await q.query('INSERT INTO app_login_challenges(state,device_id,user_id,purpose,expires_at) VALUES($1,$2,$3,$4,$5)',[state,auth.deviceId,auth.userId,purpose,now()+300000]);
        return {state};
      });
    },
    async consumeWechat(auth,state) {
      return db.transaction('system:account-binding',async q=> {
        const row=(await q.query('UPDATE app_login_challenges SET consumed=true WHERE state=$1 AND device_id=$2 AND user_id=$3 AND NOT consumed AND expires_at>$4 RETURNING *',[state,auth.deviceId,auth.userId,now()])).rows[0];
        return row || fail('LOGIN_STATE_INVALID');
      });
    },
    async finishWechat(auth,challenge,{appId,openid}) {
      const provider=`wechat-app:${appId}`;
      return db.transaction('system:account-binding',async q=> {
        const device=(await q.query('SELECT * FROM app_login_devices WHERE device_id=$1',[auth.deviceId])).rows[0];
        const active=device?.user_id && Number(device.expires_at)>now();
        if((active ? device.user_id : auth.deviceId)!==auth.userId || (active ? device.version : null)!==(auth.deviceVersion || null)) return fail('LOGIN_STATE_INVALID');
        const existing=(await q.query('SELECT user_id FROM app_login_identities WHERE provider=$1 AND subject=$2',[provider,openid])).rows[0];
        if(challenge.purpose==='link') {
          if(auth.authMethod!=='phone' || !Number.isFinite(auth.authenticatedAt) || now()-auth.authenticatedAt>300000) return fail('RECENT_PHONE_LOGIN_REQUIRED');
          if(existing && existing.user_id!==auth.userId) return fail('ACCOUNT_LINK_CONFLICT');
          const linked=(await q.query('SELECT subject FROM app_login_identities WHERE provider=$1 AND user_id=$2',[provider,auth.userId])).rows[0];
          if(linked && linked.subject!==openid) return fail('ACCOUNT_LINK_CONFLICT');
        }
        const userId=challenge.purpose==='link' ? auth.userId : existing?.user_id || await newUser(q,`app-account:${provider}:${openid}`);
        if(!users.getUser(userId) || users.getUser(userId).status!=='active') return fail('ACCOUNT_UNAVAILABLE');
        if(!existing) await q.query('INSERT INTO app_login_identities VALUES($1,$2,$3)',[provider,openid,userId]);
        return attach(q,auth.deviceId,userId);
      });
    },
  };
}
