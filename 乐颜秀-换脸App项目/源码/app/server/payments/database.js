import { Pool } from 'pg';

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_accounts (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS billing_instance (id INTEGER PRIMARY KEY CHECK(id=1), app_id TEXT NOT NULL, merchant_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_catalog (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL, products JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS billing_orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES billing_accounts(id), idem TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), trade_id TEXT UNIQUE, payload JSONB NOT NULL, UNIQUE(user_id,idem));
CREATE INDEX IF NOT EXISTS billing_orders_user ON billing_orders(user_id);
CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES billing_orders(id), payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS billing_grants (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES billing_accounts(id), order_id TEXT REFERENCES billing_orders(id),
 initial INTEGER NOT NULL CHECK(initial>0), available INTEGER NOT NULL CHECK(available>=0), held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0),
 used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0), revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked>=0),
 starts_at BIGINT NOT NULL, ends_at BIGINT, kind TEXT NOT NULL,
 CHECK(initial=available+held+used+revoked), UNIQUE(order_id,kind));
CREATE INDEX IF NOT EXISTS billing_grants_user ON billing_grants(user_id);
CREATE TABLE IF NOT EXISTS billing_reservations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES billing_accounts(id), grant_id TEXT NOT NULL REFERENCES billing_grants(id),
 purpose TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','success','refunded')), created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_refunds (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES billing_orders(id), user_id TEXT NOT NULL,
 provider_id TEXT UNIQUE, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS billing_ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, reference_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
 created_at BIGINT NOT NULL, UNIQUE(reference_id,kind));
CREATE TABLE IF NOT EXISTS billing_audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, payload JSONB NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_reconciliation (id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_phones (phone_hash TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES billing_accounts(id), masked TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS billing_devices (device_user_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES billing_accounts(id), disabled BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS billing_otp (id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, masked TEXT NOT NULL,
 device_user_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('bind','recover')), code_hash TEXT NOT NULL,
 ip_hash TEXT NOT NULL, created_at BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent BOOLEAN NOT NULL DEFAULT false, consumed BOOLEAN NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS billing_otp_created ON billing_otp(created_at);
ALTER TABLE billing_otp DROP CONSTRAINT IF EXISTS billing_otp_purpose_check;
ALTER TABLE billing_otp ADD CONSTRAINT billing_otp_purpose_check CHECK(purpose IN ('bind','recover','login','link-phone'));
ALTER TABLE billing_otp ADD COLUMN IF NOT EXISTS login_user_id TEXT;
ALTER TABLE billing_otp ADD COLUMN IF NOT EXISTS device_version TEXT;
CREATE TABLE IF NOT EXISTS app_login_devices (
 device_id TEXT PRIMARY KEY, user_id TEXT REFERENCES billing_accounts(id), version TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS app_login_identities (
 provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES billing_accounts(id),
 PRIMARY KEY(provider,subject), UNIQUE(provider,user_id));
CREATE TABLE IF NOT EXISTS app_login_challenges (
 state TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL, purpose TEXT NOT NULL,
 expires_at BIGINT NOT NULL, consumed BOOLEAN NOT NULL DEFAULT false);
`;

export function createBillingDatabase(pool) {
  return {
    query: (sql, args = []) => pool.query(sql, args),
    initialize: () => pool.query(BILLING_SCHEMA),
    async transaction(userId, operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // All money/entitlement mutations for an account share a durable row lock.
        await client.query('INSERT INTO billing_accounts(id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
        await client.query('SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE', [userId]);
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

export function connectBillingDatabase(env = process.env) {
  if (!env.BILLING_DATABASE_URL) throw new Error('BILLING_DATABASE_URL_REQUIRED');
  const url = new URL(env.BILLING_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('BILLING_DATABASE_URL_INVALID');
  const production = (env.DEPLOY_ENV || env.NODE_ENV) === 'production';
  if (production && [...url.searchParams.keys()].some(key => key.startsWith('ssl'))) throw new Error('CONFIGURE_BILLING_TLS_EXPLICITLY');
  const pool=new Pool({ connectionString: env.BILLING_DATABASE_URL, max: 10,
    connectionTimeoutMillis: 5000, statement_timeout: 15000,
    ...(production ? { ssl: { rejectUnauthorized: true } } : {}) });
  pool.on('error',()=>{console.error('BILLING_DATABASE_CONNECTION_LOST');});
  return createBillingDatabase(pool);
}
