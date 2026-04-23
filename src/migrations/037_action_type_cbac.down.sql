-- Down migration 037 — reverse CBAC schema changes.
--
-- Safe rollback path:
--   1. Set CBAC_ENFORCEMENT=warn in env (logs deny decisions but does not block).
--   2. Wait for in-flight requests to drain.
--   3. Run this down migration.
DROP INDEX IF EXISTS idx_cbac_decision_decision;
DROP INDEX IF EXISTS idx_cbac_decision_resource;
DROP INDEX IF EXISTS idx_cbac_decision_subject;
DROP TABLE IF EXISTS cbac_decision_log;

ALTER TABLE action_type DROP COLUMN IF EXISTS required_markings;
ALTER TABLE action_type DROP COLUMN IF EXISTS denied_principals;
ALTER TABLE action_type DROP COLUMN IF EXISTS allowed_principals;
