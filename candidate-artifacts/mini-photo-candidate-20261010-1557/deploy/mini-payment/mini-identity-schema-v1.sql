-- Additive identity migration for the standalone WeChat mini-program payment API.
-- Apply only to its reviewed vp_ database after backing it up. Existing 12 tables
-- and vp_schema version 1 are unchanged; there is no legacy identity import.
-- Runtime credentials need CRUD on this table, not migration privileges.
-- Target instance must also be confirmed in DMC: cynosdbmysql-7jg96bj6.
-- Execute this preflight first. Stop if target_verified is not 1 or any SQL
-- fails; a SELECT is a review checkpoint, not an automatic execution guard.
USE `leyanxiu_xpay_sandbox`;
SELECT DATABASE() AS database_name,
  (DATABASE() = 'leyanxiu_xpay_sandbox'
    AND (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_schema) = 1
    AND (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_schema WHERE version = 1) = 1
    AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_environment
      WHERE id <> 1 OR app_id <> 'REDACTED_APP_IDENTIFIER' OR env <> 1)) AS target_verified;

-- Fully qualify both ends even if a client changes the selected database.
CREATE TABLE IF NOT EXISTS leyanxiu_xpay_sandbox.vp_auth_sessions (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL,
  app_id VARCHAR(80) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  CHECK(expires_at - created_at = 86400000),
  FOREIGN KEY(user_id) REFERENCES leyanxiu_xpay_sandbox.vp_accounts(user_id),
  INDEX vp_auth_sessions_user (user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- IF NOT EXISTS may skip an incompatible existing table. Success is not
-- structure acceptance: compare this DDL with the definition above, including
-- unique token_hash, FK target, user index and enforced one-day TTL CHECK.
-- Never drop/rebuild an existing table to make this check pass.
SHOW CREATE TABLE leyanxiu_xpay_sandbox.vp_auth_sessions;
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'leyanxiu_xpay_sandbox' AND TABLE_NAME = 'vp_auth_sessions';
SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, c.ENFORCED, k.COLUMN_NAME,
  k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
  checks.CHECK_CLAUSE
FROM information_schema.TABLE_CONSTRAINTS c
LEFT JOIN information_schema.KEY_COLUMN_USAGE k
  ON k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
    AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME
LEFT JOIN information_schema.CHECK_CONSTRAINTS checks
  ON checks.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND checks.CONSTRAINT_NAME = c.CONSTRAINT_NAME
WHERE c.CONSTRAINT_SCHEMA = 'leyanxiu_xpay_sandbox' AND c.TABLE_NAME = 'vp_auth_sessions'
ORDER BY c.CONSTRAINT_TYPE, c.CONSTRAINT_NAME, k.ORDINAL_POSITION;
