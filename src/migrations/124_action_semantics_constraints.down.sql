-- Reverse 124 (NOT NULL/CHECK promotion). Drops the CHECK constraints and
-- reverts NOT NULL to NULLABLE so rollback is safe without dropping data.
-- Per rollback policy: do NOT drop the semantics columns themselves.

ALTER TABLE action_type DROP CONSTRAINT IF EXISTS action_type_semantics_version_domain;
ALTER TABLE action_type DROP CONSTRAINT IF EXISTS action_type_execution_mode_domain;
ALTER TABLE action_type DROP CONSTRAINT IF EXISTS action_type_delete_policy_domain;
ALTER TABLE action_audit_log DROP CONSTRAINT IF EXISTS action_audit_log_semantics_version_domain;
ALTER TABLE action_audit_log DROP CONSTRAINT IF EXISTS action_audit_log_execution_mode_domain;

ALTER TABLE action_type ALTER COLUMN semantics_version DROP NOT NULL;
ALTER TABLE action_type ALTER COLUMN execution_mode DROP NOT NULL;
ALTER TABLE action_type ALTER COLUMN delete_policy DROP NOT NULL;

ALTER TABLE action_audit_log ALTER COLUMN semantics_version DROP NOT NULL;
ALTER TABLE action_audit_log ALTER COLUMN execution_mode DROP NOT NULL;
