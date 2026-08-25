-- ---------------------------------------------------------------------------
-- Migration 124 — Stage D: Promote semantics columns to NOT NULL + CHECK.
--
-- Runs ONLY after migration 123 backfill verified no NULLs remain. Adds:
--   * NOT NULL on action_type.{semantics_version, execution_mode, delete_policy}
--   * NOT NULL on action_audit_log.{semantics_version, execution_mode}
--   * CHECK constraints restricting the value domains to the supported set.
--
-- correlation_id on action_audit_log STAYS NULLABLE (legacy rows + non-action
-- events have no correlation id). semantics_version on action_audit_log only
-- goes NOT NULL because 123 backfilled it.
--
-- Constraints are added NOT VALID where supported (PG16) so existing rows are
-- not re-validated table-rewrite-style; a separate VALIDATE CONSTRAINT pass
-- confirms them online.
-- ---------------------------------------------------------------------------

ALTER TABLE action_type
  ALTER COLUMN semantics_version SET NOT NULL;
ALTER TABLE action_type
  ALTER COLUMN execution_mode SET NOT NULL;
ALTER TABLE action_type
  ALTER COLUMN delete_policy SET NOT NULL;

ALTER TABLE action_audit_log
  ALTER COLUMN semantics_version SET NOT NULL;
ALTER TABLE action_audit_log
  ALTER COLUMN execution_mode SET NOT NULL;

-- Value-domain CHECKs.
ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_semantics_version_domain;
ALTER TABLE action_type
  ADD CONSTRAINT action_type_semantics_version_domain
  CHECK (semantics_version IN (1, 2)) NOT VALID;

ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_execution_mode_domain;
ALTER TABLE action_type
  ADD CONSTRAINT action_type_execution_mode_domain
  CHECK (execution_mode IN ('declarative', 'function')) NOT VALID;

ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_delete_policy_domain;
ALTER TABLE action_type
  ADD CONSTRAINT action_type_delete_policy_domain
  CHECK (delete_policy IN ('legacy_unchecked', 'restrict')) NOT VALID;

-- Validate the NOT-VALID constraints online (fast index-ish scan on PG16).
ALTER TABLE action_type
  VALIDATE CONSTRAINT action_type_semantics_version_domain;
ALTER TABLE action_type
  VALIDATE CONSTRAINT action_type_execution_mode_domain;
ALTER TABLE action_type
  VALIDATE CONSTRAINT action_type_delete_policy_domain;

-- Audit log domain checks (semantics_version/execution_mode only).
ALTER TABLE action_audit_log
  DROP CONSTRAINT IF EXISTS action_audit_log_semantics_version_domain;
ALTER TABLE action_audit_log
  ADD CONSTRAINT action_audit_log_semantics_version_domain
  CHECK (semantics_version IN (1, 2)) NOT VALID;
ALTER TABLE action_audit_log
  VALIDATE CONSTRAINT action_audit_log_semantics_version_domain;

ALTER TABLE action_audit_log
  DROP CONSTRAINT IF EXISTS action_audit_log_execution_mode_domain;
ALTER TABLE action_audit_log
  ADD CONSTRAINT action_audit_log_execution_mode_domain
  CHECK (execution_mode IN ('declarative', 'function')) NOT VALID;
ALTER TABLE action_audit_log
  VALIDATE CONSTRAINT action_audit_log_execution_mode_domain;
