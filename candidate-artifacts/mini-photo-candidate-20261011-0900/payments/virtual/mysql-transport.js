import fs from 'node:fs';

// A single, reviewed sandbox target, not a blanket RFC1918 exception. These
// identifiers prevent configuration mistakes; they do not authenticate a VPC.
// Before each deployment, recheck this target using the official cloud API.
export const builtinSandboxMysql = Object.freeze({
  appId: 'REDACTED_APP_IDENTIFIER',
  cloudEnvId: 'leyanxiu-prod-d5gimob8af6a6e5c9',
  instanceId: 'cynosdbmysql-7jg96bj6',
  host: 'REDACTED_PRIVATE_NETWORK_ADDRESS', port: 3306,
  database: 'leyanxiu_xpay_sandbox', user: 'lyx_xpay_sandbox',
});
export const privateSandboxTransport = 'cloudrun_builtin_private';

export function virtualMysqlOptions(env = process.env, { allowCloudrunPrivateSandbox = false } = {}) {
  if (!env.XPAY_MYSQL_HOST || !env.XPAY_MYSQL_USER || !env.XPAY_MYSQL_PASSWORD || !env.XPAY_MYSQL_DATABASE) {
    throw new Error('XPAY_MYSQL_CONFIG_REQUIRED');
  }
  const transport = env.XPAY_MYSQL_TRANSPORT || 'tls';
  const options = { host: env.XPAY_MYSQL_HOST, port: Number(env.XPAY_MYSQL_PORT || 3306),
    user: env.XPAY_MYSQL_USER, password: env.XPAY_MYSQL_PASSWORD, database: env.XPAY_MYSQL_DATABASE,
    connectTimeout: 10000 };
  if (transport === privateSandboxTransport) {
    const target = builtinSandboxMysql;
    if (!allowCloudrunPrivateSandbox || env.RELEASE_CHANNEL !== 'wechat-mini-program'
      || env.AUTH_MODE !== 'wechat' || env.XPAY_ENV !== '1' || env.XPAY_DB_BACKEND !== 'mysql'
      || !['closed', 'sandbox'].includes(env.XPAY_MODE)) throw new Error('XPAY_MYSQL_PRIVATE_SANDBOX_ONLY');
    if (env.WECHAT_APP_ID !== target.appId || env.XPAY_CLOUD_ENV_ID !== target.cloudEnvId
      || env.XPAY_MYSQL_INSTANCE_ID !== target.instanceId || options.host !== target.host
      || options.port !== target.port || options.database !== target.database || options.user !== target.user) {
      throw new Error('XPAY_MYSQL_PRIVATE_TARGET_MISMATCH');
    }
    // A CA here suggests a mistaken expectation of encryption. Require an
    // unambiguous selection; no TLS handshake error ever reaches this branch.
    if (env.XPAY_MYSQL_CA_FILE?.trim()) throw new Error('XPAY_MYSQL_TRANSPORT_CONFLICT');
    return options;
  }
  if (transport !== 'tls') throw new Error('XPAY_MYSQL_TRANSPORT_INVALID');
  if (!env.XPAY_MYSQL_CA_FILE?.trim()) throw new Error('XPAY_MYSQL_TLS_REQUIRED');
  return { ...options, ssl: { ca: fs.readFileSync(env.XPAY_MYSQL_CA_FILE, 'utf8'),
    rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' } };
}

// Read only, before ledger binding, login, background jobs or opening HTTP.
// Refuse even an empty ledger: this exception is for the existing sandbox.
export async function verifyPrivateSandboxDatabase(database) {
  if (database.backend !== 'mysql') throw new Error('XPAY_MYSQL_PRIVATE_SANDBOX_ONLY');
  await database.transaction(async q => {
    const [connection] = await q('SELECT DATABASE() AS db, CURRENT_USER() AS account');
    if (connection?.db !== builtinSandboxMysql.database
      || typeof connection.account !== 'string'
      || !connection.account.startsWith(`${builtinSandboxMysql.user}@`)) {
      throw new Error('XPAY_MYSQL_PRIVATE_CONNECTION_MISMATCH');
    }
    const rows = await q('SELECT id, app_id, env FROM vp_environment');
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].app_id !== builtinSandboxMysql.appId || rows[0].env !== 1) {
      throw new Error('XPAY_MYSQL_PRIVATE_LEDGER_MISMATCH');
    }
  });
}
