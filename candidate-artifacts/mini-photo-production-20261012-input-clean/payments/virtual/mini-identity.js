import crypto from 'node:crypto';

// The bearer session lasts one day. vp_sessions is a separate, shorter-lived
// WeChat payment session_key store owned by the existing virtual ledger.
export const miniAuthTtlMs = 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const fail = code => { throw new Error(code); };
const hashToken = token => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

export function miniIdentitySchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) fail('XPAY_IDENTITY_DATABASE_REQUIRED');
  const mysql = dialect === 'mysql';
  const table = `CREATE TABLE IF NOT EXISTS vp_auth_sessions (
    id VARCHAR(80) PRIMARY KEY,
    user_id VARCHAR(80) NOT NULL,
    app_id VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at BIGINT,
    CHECK(expires_at - created_at = 86400000),
    FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id)${mysql ? ',\n    INDEX vp_auth_sessions_user (user_id, expires_at)' : ''}
  )${mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : ''}`;
  return mysql ? [table] : [table, 'CREATE INDEX IF NOT EXISTS vp_auth_sessions_user ON vp_auth_sessions(user_id, expires_at)'];
}

function bearer(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  return match && tokenPattern.test(match[1]) ? match[1] : null;
}

const publicUser = userId => ({ id: userId, channel: 'wechat', authMethod: 'wechat' });

// Only call createLogin after the server has exchanged a wx.login code with
// WeChat. A client-supplied openid is not authentication. vp_accounts is the
// authoritative existing mapping; this module cannot migrate a legacy
// compliance identity which is absent from that table.
export function createMiniIdentity({ database, appId, bindSession, ensureUser = async () => {},
  userAvailable = async () => true, now = Date.now }) {
  if (!database?.transaction || !['mysql', 'sqlite'].includes(database.backend)) fail('XPAY_IDENTITY_DATABASE_REQUIRED');
  if (typeof appId !== 'string' || !appId.trim() || appId.length > 80 || typeof bindSession !== 'function'
    || typeof ensureUser !== 'function' || typeof userAvailable !== 'function') fail('XPAY_IDENTITY_CONFIG_REQUIRED');
  const tx = database.transaction.bind(database);
  const lock = database.backend === 'mysql' ? ' FOR UPDATE' : '';
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('XPAY_IDENTITY_CLOCK_INVALID');
    return value;
  };
  const audit = (q, userId, action, sessionId, at) => q(
    'INSERT INTO vp_audit(id,user_id,action,reference_id,detail,created_at) VALUES (?,?,?,?,?,?)',
    [crypto.randomUUID().replaceAll('-', ''), userId, action, sessionId, '{}', at],
  );
  const lookup = (q, tokenHash) => q(
    `SELECT s.id,s.user_id,s.expires_at,s.revoked_at,a.openid FROM vp_auth_sessions s
      JOIN vp_accounts a ON a.user_id = s.user_id AND a.app_id = s.app_id
      WHERE s.token_hash = ? AND s.app_id = ?`,
    [tokenHash, appId],
  );
  const accountFor = openid => tx(async q => {
    const existing = (await q(`SELECT user_id FROM vp_accounts WHERE app_id = ? AND openid = ?${lock}`, [appId, openid]))[0];
    if (existing) return existing.user_id;
    const allocated = `usr_${crypto.randomUUID()}`;
    await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [allocated, appId, openid]);
    return allocated;
  }).catch(async error => {
    // Another worker can win the unique (AppID, openid) insert. Resolve only
    // that committed mapping; unrelated failures must not produce a login.
    if (error?.errno !== 1062) throw error;
    const existing = await tx(async q => (await q('SELECT user_id FROM vp_accounts WHERE app_id = ? AND openid = ?', [appId, openid]))[0]);
    if (!existing) throw error;
    return existing.user_id;
  });

  return {
    async createLogin({ openid, sessionKey } = {}) {
      if (typeof openid !== 'string' || !openid || openid.length > 128
        || typeof sessionKey !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(sessionKey)
        || Buffer.from(sessionKey, 'base64').length !== 16) fail('XPAY_IDENTITY_INVALID');

      const userId = await accountFor(openid);
      // Complete the full service's durable user registration before rotating
      // payment keys or issuing a bearer. Failure preserves only the mapping.
      const mapping = { userId, appId, openid };
      await ensureUser(mapping);
      if (await userAvailable(mapping) !== true) fail('XPAY_ACCOUNT_UNAVAILABLE');
      const sessionId = `ses_${crypto.randomUUID()}`;
      // Failure leaves only a stable identity mapping, never an authenticated
      // token. A retry reuses the same mapping and the ledger owns encryption.
      await bindSession({ userId, sessionId, appId, openid, sessionKey });
      if (await userAvailable(mapping) !== true) fail('XPAY_ACCOUNT_UNAVAILABLE');

      const token = crypto.randomBytes(32).toString('base64url');
      const issuedAt = clock();
      const expiresAt = issuedAt + miniAuthTtlMs;
      await tx(async q => {
        const account = (await q(`SELECT app_id,openid FROM vp_accounts WHERE user_id = ?${lock}`, [userId]))[0];
        if (!account || account.app_id !== appId || account.openid !== openid) fail('XPAY_IDENTITY_CONFLICT');
        const paymentSession = (await q('SELECT id,expires_at FROM vp_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]))[0];
        if (!paymentSession || Number(paymentSession.expires_at) <= issuedAt) fail('XPAY_LOGIN_SUPERSEDED');
        await q('DELETE FROM vp_auth_sessions WHERE app_id = ? AND expires_at <= ?', [appId, issuedAt]);
        await q('INSERT INTO vp_auth_sessions(id,user_id,app_id,token_hash,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)',
          [sessionId, userId, appId, hashToken(token), issuedAt, expiresAt]);
        await audit(q, userId, 'auth.session.issued', sessionId, issuedAt);
      });
      return { token, user: publicUser(userId), expiresAt: new Date(expiresAt).toISOString() };
    },

    async authenticateBearer(authorization) {
      const token = bearer(authorization);
      if (!token) return null;
      const at = clock();
      const session = await tx(async q => {
        const session = (await lookup(q, hashToken(token)))[0];
        if (!session || session.revoked_at !== null || Number(session.expires_at) <= at) return null;
        return session;
      });
      if (!session || await userAvailable({ userId: session.user_id, appId, openid: session.openid }) !== true) return null;
      return { userId: session.user_id, sessionId: session.id, channel: 'wechat', authMethod: 'wechat',
        user: publicUser(session.user_id), expiresAt: new Date(Number(session.expires_at)).toISOString() };
    },

    async logout(authorization) {
      const token = bearer(authorization);
      if (!token) return false;
      const at = clock();
      return tx(async q => {
        const session = (await lookup(q, hashToken(token)))[0];
        if (!session || session.revoked_at !== null || Number(session.expires_at) <= at) return false;
        const changed = await q('UPDATE vp_auth_sessions SET revoked_at = ? WHERE id = ? AND app_id = ? AND revoked_at IS NULL', [at, session.id, appId]);
        if (Number(changed.affectedRows ?? changed.changes) !== 1) return false;
        await audit(q, session.user_id, 'auth.session.revoked', session.id, at);
        return true;
      });
    },

    async revokeUserSessions(userId) {
      const at = clock();
      return tx(async q => {
        const sessions = await q(`SELECT id FROM vp_auth_sessions WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL${lock}`, [userId, appId]);
        if (!sessions.length) return 0;
        await q('UPDATE vp_auth_sessions SET revoked_at = ? WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL', [at, userId, appId]);
        for (const session of sessions) await audit(q, userId, 'auth.session.revoked', session.id, at);
        return sessions.length;
      });
    },
  };
}
