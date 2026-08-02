-- ---------------------------------------------------------------------------
-- 156 — Function invocation contract + canonical signature metadata.
--
-- Adds, on function_registry_function_version:
--   invocation_contract  — persisted per immutable published version:
--                          'legacy-object-envelope-v1' (pre-contract
--                          artifacts; behavior preserved verbatim) or
--                          'typescript-v2-positional-v2' (standard TS
--                          positional invocation; all new publishes).
--   signature_hash       — canonical signature hash; new publishes write
--                          'sha256:<hex>'; existing rows are backfilled
--                          RESTART-SAFELY and deterministically below with
--                          a SQL-domain hash ('legacy-md5:<hex>').
--
-- Adds, on automation_effect_execution:
--   resolved_function_semver / resolved_artifact_sha256 —
--                          the exact immutable artifact resolved ONCE per
--                          effect execution (auto-upgrade included);
--                          retries re-execute this artifact, never
--                          "latest".
--   invocation_contract / signature_hash — recorded per execution for
--                          audit and legacy-migration observability.
--
-- Rollback / forward recovery:
--   156_function_invocation_contract.down.sql drops the columns
--   (invocation contract column defaults mean a re-run of this script is
--   idempotent; dropping columns never touches existing automation rows).
--   Republishing a Function under the positional contract is the supported
--   forward path for moving legacy artifacts — see
--   docs in src/services/functions/canonicalSignature.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE function_registry_function_version
  ADD COLUMN IF NOT EXISTS invocation_contract TEXT NOT NULL DEFAULT 'legacy-object-envelope-v1',
  ADD COLUMN IF NOT EXISTS signature_hash TEXT;

-- Constrain the contract domain WITHOUT a long blocking table lock:
-- NOT VALID skips scanning existing rows but still enforces new writes.
DO $$
BEGIN
  IF NOT EXISTS (
    -- Namespace-qualified: pg_constraint names are GLOBAL, so a bare
    -- conname check misfires when the migration runs under a non-public
    -- search_path (per-schema test harnesses).
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'function_registry_function_version_contract_check'
       AND t.relname = 'function_registry_function_version'
       AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE function_registry_function_version
      ADD CONSTRAINT function_registry_function_version_contract_check
      CHECK (invocation_contract IN (
        'legacy-object-envelope-v1',
        'typescript-v2-positional-v2'
      )) NOT VALID;
  END IF;
END $$;
ALTER TABLE function_registry_function_version
  VALIDATE CONSTRAINT function_registry_function_version_contract_check;

-- Deterministic, restart-safe backfill (idempotent: WHERE signature_hash IS NULL).
UPDATE function_registry_function_version
   SET signature_hash = 'legacy-md5:' || md5(invocation_contract || '|' || signature::text)
 WHERE signature_hash IS NULL;

ALTER TABLE automation_effect_execution
  ADD COLUMN IF NOT EXISTS resolved_function_semver TEXT,
  ADD COLUMN IF NOT EXISTS resolved_artifact_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS invocation_contract TEXT,
  ADD COLUMN IF NOT EXISTS signature_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    -- Namespace-qualified (see the registry constraint block above).
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'automation_effect_execution_contract_check'
       AND t.relname = 'automation_effect_execution'
       AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE automation_effect_execution
      ADD CONSTRAINT automation_effect_execution_contract_check
      CHECK (invocation_contract IS NULL OR invocation_contract IN (
        'legacy-object-envelope-v1',
        'typescript-v2-positional-v2'
      )) NOT VALID;
  END IF;
END $$;
ALTER TABLE automation_effect_execution
  VALIDATE CONSTRAINT automation_effect_execution_contract_check;

-- Indexes for version resolution and execution-artifact lookup.
CREATE INDEX IF NOT EXISTS idx_frg_version_artifact_sha
  ON function_registry_function_version (artifact_sha256);
CREATE INDEX IF NOT EXISTS idx_effect_execution_artifact
  ON automation_effect_execution (resolved_artifact_sha256)
  WHERE resolved_artifact_sha256 IS NOT NULL;
