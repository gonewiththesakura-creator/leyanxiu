-- 乐颜秀微信小程序：空沙箱库首次建表，使用 root 管理会话执行。
-- 目标实例：cynosdbmysql-7jg96bj6；目标库：leyanxiu_xpay_sandbox。
-- 任意语句报错立即停止，不要点击“继续执行”，不要盲目重复运行。
-- 不删除或导入业务数据，不修改账户权限，不启用支付。
USE `leyanxiu_xpay_sandbox`;

CREATE TABLE IF NOT EXISTS vp_environment (id INTEGER PRIMARY KEY, app_id VARCHAR(80) NOT NULL, env INTEGER NOT NULL, CHECK(id = 1), CHECK(env IN (0,1))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_accounts (user_id VARCHAR(80) PRIMARY KEY, app_id VARCHAR(80) NOT NULL, openid VARCHAR(128) NOT NULL, UNIQUE(app_id, openid)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_sessions (id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, sealed LONGTEXT NOT NULL, expires_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_orders (id VARCHAR(32) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, idem VARCHAR(128) NOT NULL, status VARCHAR(32) NOT NULL, provider_id VARCHAR(128) UNIQUE, payload LONGTEXT NOT NULL, created_at BIGINT NOT NULL, checked_at BIGINT NOT NULL DEFAULT 0, UNIQUE(user_id, idem)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_buckets (id VARCHAR(100) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, order_id VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL, starts_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, quantity INTEGER NOT NULL, remaining INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0, frozen INTEGER NOT NULL DEFAULT 0, value_fen INTEGER NOT NULL, CHECK(remaining >= 0), CHECK(reserved >= 0), CHECK(frozen >= 0), CHECK(remaining + reserved + frozen <= quantity)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_reservations (id VARCHAR(128) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, bucket_id VARCHAR(100) NOT NULL, purpose VARCHAR(100) NOT NULL, status VARCHAR(32) NOT NULL, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_refunds (id VARCHAR(32) PRIMARY KEY, order_id VARCHAR(32) NOT NULL UNIQUE, user_id VARCHAR(80) NOT NULL, status VARCHAR(32) NOT NULL, payload LONGTEXT NOT NULL, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_events (id VARCHAR(160) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, digest VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_outbox (id VARCHAR(80) PRIMARY KEY, order_id VARCHAR(32) NOT NULL, kind VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_audit (id VARCHAR(32) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, action VARCHAR(64) NOT NULL, reference_id VARCHAR(128) NOT NULL, detail LONGTEXT NOT NULL, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_reconciliation (id VARCHAR(32) PRIMARY KEY, payload LONGTEXT NOT NULL, created_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS vp_schema (version INTEGER PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX vp_orders_pending ON vp_orders(status,checked_at,created_at);
CREATE INDEX vp_orders_user ON vp_orders(user_id,created_at);
CREATE INDEX vp_buckets_user ON vp_buckets(user_id,kind,expires_at);
CREATE INDEX vp_buckets_order ON vp_buckets(order_id);
CREATE INDEX vp_reservations_time ON vp_reservations(created_at);
CREATE INDEX vp_reservations_user ON vp_reservations(user_id,created_at);
CREATE INDEX vp_outbox_due ON vp_outbox(status,next_at);
CREATE INDEX vp_audit_time ON vp_audit(created_at);

INSERT IGNORE INTO vp_schema(version) VALUES (1);

-- 以下为结构检查；不代表事务、恢复或支付业务验收通过。
SELECT DATABASE() AS database_name,
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE') AS table_count,
  (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND ENGINE = 'InnoDB'
      AND TABLE_COLLATION = 'utf8mb4_bin') AS matching_tables,
  (SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN
      ('vp_orders_pending', 'vp_orders_user', 'vp_buckets_user', 'vp_buckets_order',
       'vp_reservations_time', 'vp_reservations_user', 'vp_outbox_due', 'vp_audit_time')) AS index_count,
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK'
      AND ENFORCED = 'YES') AS checks_enforced,
  (SELECT MAX(version) FROM vp_schema) AS schema_version;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;
