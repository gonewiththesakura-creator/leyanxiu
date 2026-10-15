-- Read-only, aggregate-only DMC checks. No private order/user/openid is selected.
-- Run each SELECT separately on the existing instance; no USE/DDL/DML/transaction change.
-- 013 must still be closed, and no old-environment tester/admin operation in flight.
-- Expected environment_rows=expected_environment_rows=1 in both results.
-- Before replacing default env1 routing: every unresolved_* and every credit_* must be 0.
-- 2026-10-09 historical sandbox baseline: orders_total=3, orders_closed=2,
-- orders_refunded=1, refunds_total=1, refunds_succeeded=1, outbox_total=2,
-- outbox_done=2. This is a comparison baseline, not a current database assertion.
SELECT
  'sandbox_env1_before_default_route_replacement' AS check_name,
  UTC_TIMESTAMP() AS checked_at_utc,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_environment) AS environment_rows,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_environment WHERE id=1 AND app_id='REDACTED_APP_IDENTIFIER' AND env=1) AS expected_environment_rows,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_orders) AS orders_total,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_orders WHERE status='closed') AS orders_closed,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_orders WHERE status='refunded') AS orders_refunded,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_orders WHERE status NOT IN ('closed','refunded')) AS unresolved_orders,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_refunds) AS refunds_total,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_refunds WHERE status='succeeded') AS refunds_succeeded,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_refunds WHERE status NOT IN ('succeeded','rejected')) AS unresolved_refunds,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_outbox) AS outbox_total,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_outbox WHERE status='done') AS outbox_done,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_outbox WHERE status<>'done') AS unresolved_outbox,
  (SELECT COALESCE(SUM(remaining),0) FROM leyanxiu_xpay_sandbox.vp_buckets) AS credit_remaining,
  (SELECT COALESCE(SUM(reserved),0) FROM leyanxiu_xpay_sandbox.vp_buckets) AS credit_reserved,
  (SELECT COALESCE(SUM(frozen),0) FROM leyanxiu_xpay_sandbox.vp_buckets) AS credit_frozen,
  (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_reservations WHERE status NOT IN ('consumed','returned')) AS unresolved_reservations;

-- Before the first env0 payment, production orders/refunds/outbox and all credits
-- should be 0. Identity/session rows intentionally do not participate in this check.
-- A nonzero result is a reason to inspect the existing operation, not to delete it.
SELECT
  'production_env0_before_first_merchant_payment' AS check_name,
  UTC_TIMESTAMP() AS checked_at_utc,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_environment) AS environment_rows,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_environment WHERE id=1 AND app_id='REDACTED_APP_IDENTIFIER' AND env=0) AS expected_environment_rows,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_orders) AS orders_total,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_refunds) AS refunds_total,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_outbox) AS outbox_total,
  (SELECT COALESCE(SUM(remaining),0) FROM leyanxiu_xpay_production.vp_buckets) AS credit_remaining,
  (SELECT COALESCE(SUM(reserved),0) FROM leyanxiu_xpay_production.vp_buckets) AS credit_reserved,
  (SELECT COALESCE(SUM(frozen),0) FROM leyanxiu_xpay_production.vp_buckets) AS credit_frozen,
  (SELECT COUNT(*) FROM leyanxiu_xpay_production.vp_reservations WHERE status NOT IN ('consumed','returned')) AS unresolved_reservations;
