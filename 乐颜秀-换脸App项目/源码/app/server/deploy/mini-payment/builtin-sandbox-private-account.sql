-- REVIEWED CANDIDATE ONLY; not executed by application startup or build scripts.
-- Target instance: cynosdbmysql-7jg96bj6; account used exclusively by env=1.
-- Preconditions: saved backup, inspect.sql checked, new password securely set,
-- database public access off, dedicated account has only sandbox database CRUD.
-- This changes transport protection: private SQL traffic will NOT be encrypted.
-- Do not execute against any production payment account or substitute root.
ALTER USER 'lyx_xpay_sandbox'@'%' REQUIRE NONE;
SELECT user, host, ssl_type, account_locked FROM mysql.user
WHERE user = 'lyx_xpay_sandbox' AND host = '%';
-- Rollback: first stop the sandbox API to close existing connections, then run:
-- ALTER USER 'lyx_xpay_sandbox'@'%' REQUIRE SSL;
-- This restores the previous requirement; it does not enable SSL in this DB.
