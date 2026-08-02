-- Rollback for 156_function_invocation_contract.sql.
-- Drops only schema added by 156; invocations captured in
-- automation_effect_execution output JSON are unaffected.

DROP INDEX IF EXISTS idx_effect_execution_artifact;
DROP INDEX IF EXISTS idx_frg_version_artifact_sha;

ALTER TABLE automation_effect_execution
  DROP CONSTRAINT IF EXISTS automation_effect_execution_contract_check;
ALTER TABLE automation_effect_execution
  DROP COLUMN IF EXISTS signature_hash,
  DROP COLUMN IF EXISTS invocation_contract,
  DROP COLUMN IF EXISTS resolved_artifact_sha256,
  DROP COLUMN IF EXISTS resolved_function_semver;

ALTER TABLE function_registry_function_version
  DROP CONSTRAINT IF EXISTS function_registry_function_version_contract_check;
ALTER TABLE function_registry_function_version
  DROP COLUMN IF EXISTS signature_hash,
  DROP COLUMN IF EXISTS invocation_contract;
