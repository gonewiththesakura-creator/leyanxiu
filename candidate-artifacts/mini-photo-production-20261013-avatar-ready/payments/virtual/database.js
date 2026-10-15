import fs from 'node:fs';
import path from 'node:path';

// Explicit migration; no modification to the legacy compliance snapshot or Android tables.
export function schema(dialect) {
  const text = dialect === 'mysql' ? 'LONGTEXT' : 'TEXT';
  const suffix = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : '';
  return [
    `CREATE TABLE IF NOT EXISTS vp_environment (id INTEGER PRIMARY KEY, app_id VARCHAR(80) NOT NULL, env INTEGER NOT NULL, CHECK(id = 1), CHECK(env IN (0,1)))`,
    `CREATE TABLE IF NOT EXISTS vp_accounts (user_id VARCHAR(80) PRIMARY KEY, app_id VARCHAR(80) NOT NULL, openid VARCHAR(128) NOT NULL, UNIQUE(app_id, openid))`,
    `CREATE TABLE IF NOT EXISTS vp_sessions (id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, sealed ${text} NOT NULL, expires_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_orders (id VARCHAR(32) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, idem VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL, provider_id VARCHAR(128) UNIQUE, payload ${text} NOT NULL, created_at BIGINT NOT NULL, checked_at BIGINT NOT NULL DEFAULT 0, UNIQUE(user_id, idem))`,
    `CREATE TABLE IF NOT EXISTS vp_buckets (id VARCHAR(100) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, order_id VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL, starts_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, quantity INTEGER NOT NULL, remaining INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, value_fen INTEGER NOT NULL, CHECK(remaining >= 0), CHECK(reserved >= 0), CHECK(frozen >= 0), CHECK(remaining + reserved + frozen <= quantity))`,
    `CREATE TABLE IF NOT EXISTS vp_reservations (id VARCHAR(128) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, bucket_id VARCHAR(100) NOT NULL, purpose VARCHAR(100) NOT NULL, status VARCHAR(32) NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_refunds (id VARCHAR(32) PRIMARY KEY, order_id VARCHAR(32) NOT NULL UNIQUE, user_id VARCHAR(80) NOT NULL, status VARCHAR(32) NOT NULL, payload ${text} NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_events (id VARCHAR(160) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, digest VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_outbox (id VARCHAR(80) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_audit (id VARCHAR(32) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, action VARCHAR(64) NOT NULL, reference_id VARCHAR(128) NOT NULL, detail ${text} NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_reconciliation (id VARCHAR(32) PRIMARY KEY, payload ${text} NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS vp_schema (version INTEGER PRIMARY KEY)`,
  ].map(sql => sql + suffix);
}

const indexes = [
  ['vp_orders_pending', 'vp_orders', 'status,checked_at,created_at'],
  ['vp_orders_user', 'vp_orders', 'user_id,created_at'],
  ['vp_buckets_user', 'vp_buckets', 'user_id,kind,expires_at'],
  ['vp_buckets_order', 'vp_buckets', 'order_id'],
  ['vp_reservations_time', 'vp_reservations', 'created_at'],
  ['vp_reservations_user', 'vp_reservations', 'user_id,created_at'],
  ['vp_outbox_due', 'vp_outbox', 'status,next_at'],
  ['vp_audit_time', 'vp_audit', 'created_at'],
];

export async function openVirtualDatabase({ backend, filename, mysqlOptions, migrate = false }) {
  let queue = Promise.resolve();
  if (backend === 'sqlite') {
    if (!filename || !path.isAbsolute(filename)) throw new Error('XPAY_SQLITE_ABSOLUTE_PATH_REQUIRED');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const { default: Database } = await import('better-sqlite3'); const db = new Database(filename);
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000');
    const query = async (sql, args = []) => /^\s*(SELECT|PRAGMA)/i.test(sql) ? db.prepare(sql).all(...args) : db.prepare(sql).run(...args);
    try {
      if (migrate) {
        for (const sql of schema('sqlite')) db.exec(sql);
        for (const [name, table, columns] of indexes) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`);
        db.prepare('INSERT OR IGNORE INTO vp_schema(version) VALUES (1)').run();
      }
      if (db.prepare('SELECT version FROM vp_schema').get()?.version !== 1) throw new Error('XPAY_MIGRATION_REQUIRED');
    } catch (error) { db.close(); throw error; }
    return {
      backend,
      transaction(callback) {
        const operation = queue.then(async () => {
          db.exec('BEGIN IMMEDIATE');
          try { const result = await callback(query); db.exec('COMMIT'); return result; }
          catch (error) { db.exec('ROLLBACK'); throw error; }
        });
        queue = operation.catch(() => {}); return operation;
      },
      async close() { await queue; db.close(); },
    };
  }
  if (backend !== 'mysql') throw new Error('XPAY_DATABASE_REQUIRED');
  const { createPool } = await import('mysql2/promise');
  const pool = createPool({ ...mysqlOptions, connectionLimit: 5, supportBigNumbers: true, bigNumberStrings: false,
    multipleStatements: false, charset: 'utf8mb4_bin', enableKeepAlive: true });
  try {
    if (migrate) {
      for (const sql of schema('mysql')) await pool.query(sql);
      for (const [name, table, columns] of indexes) {
        try { await pool.query(`CREATE INDEX ${name} ON ${table}(${columns})`); }
        catch (error) { if (error.errno !== 1061) throw error; }
      }
      await pool.query('INSERT IGNORE INTO vp_schema(version) VALUES (1)');
    }
    const [version] = await pool.query('SELECT version FROM vp_schema');
    if (version[0]?.version !== 1) throw new Error('XPAY_MIGRATION_REQUIRED');
  } catch (error) { await pool.end(); throw error; }
  return {
    backend,
    async transaction(callback) {
      // Callbacks contain only database work. Retry only a definite InnoDB deadlock rollback.
      for (let attempt = 0; attempt < 3; attempt++) {
        const connection = await pool.getConnection();
        try {
          await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'); await connection.beginTransaction();
          const result = await callback(async (sql, args = []) => (await connection.execute(sql, args))[0]);
          await connection.commit(); return result;
        } catch (error) {
          await connection.rollback().catch(() => {});
          if (error.errno !== 1213 || attempt === 2) throw error;
        } finally { connection.release(); }
      }
    },
    close: () => pool.end(),
  };
}
