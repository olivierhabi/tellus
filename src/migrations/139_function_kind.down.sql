-- Rollback for 139_function_kind.sql

DROP INDEX IF EXISTS function_registry_function_version_kind_null_idx;

ALTER TABLE function_registry_function_version
  DROP CONSTRAINT IF EXISTS function_registry_function_version_kind_chk;

ALTER TABLE function_registry_function_version
  DROP COLUMN IF EXISTS function_kind;
