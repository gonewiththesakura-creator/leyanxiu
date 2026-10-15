-- Apply only after inspection confirms vp_environment is empty and the existing
-- sandbox contains no rows in ANY business table. Never replace a binding.
-- Apply mini-identity-schema-v1.sql first so vp_auth_sessions exists.
-- Stop on any error; do not bypass a missing-table check or continue a batch.
-- Result must be exactly id=1, the expected AppID, env=1; otherwise stop.
USE leyanxiu_xpay_sandbox;
INSERT INTO leyanxiu_xpay_sandbox.vp_environment(id, app_id, env)
SELECT 1, 'REDACTED_APP_IDENTIFIER', 1
WHERE DATABASE() = 'leyanxiu_xpay_sandbox'
  AND (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_schema) = 1
  AND (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_schema WHERE version = 1) = 1
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_environment)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_accounts)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_orders)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_sessions)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_auth_sessions)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_buckets)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_reservations)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_refunds)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_events)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_outbox)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_audit)
  AND NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.vp_reconciliation);
SELECT id, app_id, env FROM leyanxiu_xpay_sandbox.vp_environment;
SELECT DATABASE() AS database_name,
  ((SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_environment) = 1
    AND (SELECT COUNT(*) FROM leyanxiu_xpay_sandbox.vp_environment
      WHERE id = 1 AND app_id = 'REDACTED_APP_IDENTIFIER' AND env = 1) = 1) AS binding_verified;
