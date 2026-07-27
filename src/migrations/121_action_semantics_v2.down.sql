-- Reverse migration for 121_action_semantics_v2.sql (Stage A expansion).
-- Safe to run only during the Stage A–C window (before NOT NULL / CHECK
-- constraints are promoted in Stage D). All columns added in 121 are
-- nullable and default-free, so dropping them is non-destructive.

ALTER TABLE action_type
  DROP COLUMN IF EXISTS semantics_version;
ALTER TABLE action_type
  DROP COLUMN IF EXISTS execution_mode;
ALTER TABLE action_type
  DROP COLUMN IF EXISTS delete_policy;

DROP INDEX IF EXISTS idx_action_type_semantics_version;

ALTER TABLE action_audit_log
  DROP COLUMN IF EXISTS semantics_version;
ALTER TABLE action_audit_log
  DROP COLUMN IF EXISTS execution_mode;
ALTER TABLE action_audit_log
  DROP COLUMN IF EXISTS correlation_id;
