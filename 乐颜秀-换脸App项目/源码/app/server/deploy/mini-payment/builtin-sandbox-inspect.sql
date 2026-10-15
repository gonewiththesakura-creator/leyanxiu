-- READ ONLY. Run in the existing instance cynosdbmysql-7jg96bj6 using DMC.
-- Do not copy SHOW CREATE USER or authentication_string into logs/chat.
SELECT VERSION() AS version, CURRENT_USER() AS connected_account;
SELECT user, host, ssl_type, account_locked, plugin
FROM mysql.user WHERE user = 'lyx_xpay_sandbox';
SHOW GRANTS FOR 'lyx_xpay_sandbox'@'%';
SELECT version FROM leyanxiu_xpay_sandbox.vp_schema;
SELECT id, app_id, env FROM leyanxiu_xpay_sandbox.vp_environment;
SELECT COUNT(*) AS accounts FROM leyanxiu_xpay_sandbox.vp_accounts;
SELECT COUNT(*) AS orders FROM leyanxiu_xpay_sandbox.vp_orders;
-- These tables have no universal FK guarantees. Empty accounts/orders do not
-- prove that an unbound ledger contains no old or orphaned business data.
SELECT 'vp_sessions' AS table_name, COUNT(*) AS row_count FROM leyanxiu_xpay_sandbox.vp_sessions
UNION ALL SELECT 'vp_buckets', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_buckets
UNION ALL SELECT 'vp_reservations', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_reservations
UNION ALL SELECT 'vp_refunds', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_refunds
UNION ALL SELECT 'vp_events', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_events
UNION ALL SELECT 'vp_outbox', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_outbox
UNION ALL SELECT 'vp_audit', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_audit
UNION ALL SELECT 'vp_reconciliation', COUNT(*) FROM leyanxiu_xpay_sandbox.vp_reconciliation;
SELECT @@GLOBAL.partial_revokes AS partial_revokes;
-- With partial_revokes=0, underscores in database-level GRANT names must be
-- escaped to avoid wildcard access. Review roles/global grants separately.
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'leyanxiu_xpay_sandbox' ORDER BY TABLE_NAME;
-- If the auth table exists, its complete structure is verified by the final
-- SHOW CREATE TABLE/check queries in mini-identity-schema-v1.sql, not by name.
-- Backup availability and public-access state must be checked in cloud console;
-- the queries above cannot prove either.
