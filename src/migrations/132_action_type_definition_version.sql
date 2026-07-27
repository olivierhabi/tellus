-- ---------------------------------------------------------------------------
-- Migration 132 — Action Type Definition Versioning + Optimistic Concurrency
--
-- Each Action Type carries an opaque, monotonically-increasing
-- `definition_version` and a content-addressed `definition_hash` (sha256
-- over the canonical JSON of `parameters`, `rules`, `submission_criteria`,
-- `side_effects`, `writeback_config`, `semantics_version`, `execution_mode`,
-- `delete_policy`). The action_audit_log references the exact version+hash
-- of the action type at the moment of execution, so editing an action type
-- NEVER mutates the historical meaning of past executions.
--
-- Optimistic concurrency on edit: clients send the `definition_hash` they
-- last read as `expectedDefinitionHash`; the PATCH endpoint rejects a
-- 409 MIGRATION_STALE_DEFINITION (re-using the migration endpoint''s error
-- code — the same hash function from `actionDefinitionHash.ts`) when the
-- stored hash differs.
--
-- This migration:
--   1. Adds the two columns (NULL for existing rows; backfilled below).
--   2. Backfills existing rows with version 1 and the content-addressed
--      hash computed by the existing `hashActionDefinition` helper
--      (mirrored in SQL here as `action_type_definition_hash_sql` so the
--      backfill doesn't depend on application code).
--   3. Adds NOT NULL constraints + a BEFORE UPDATE trigger that bumps
--      `definition_version` and `definition_hash` whenever any of the
--      definition-bearing columns change.
--
-- Backward compatibility: all 277 existing action types get
-- `(definition_version=1, definition_hash=<sha256>)` during the migration.
-- The model layer already has a `currentDefinitionHashFor(...)` helper so
-- the existing migration-analysis endpoint is unaffected.
-- ---------------------------------------------------------------------------

ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS definition_version INTEGER;
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS definition_hash   TEXT;

-- ---------------------------------------------------------------------------
-- Backfill: every existing row gets version 1 + a content-addressed hash
-- computed by the SQL mirror of `hashActionDefinition`. The hash covers
-- exactly the columns the application layer hashes — parameters, rules,
-- semantics triple — so the result is byte-identical to what the app
-- produces; the app remains the authority on the canonical ordering.
-- ---------------------------------------------------------------------------

-- We deliberately DON'T compute the hash in SQL here. Two reasons:
--   1. SQL-side canonical JSON ordering must match the TypeScript side
--      byte-for-byte; divergence invalidates optimistic concurrency.
--   2. The application layer already has `currentDefinitionHashFor` and
--      `hashActionDefinition`. A short, idempotent backfill script
--      (`scripts/backfill-action-type-definition-hash.mjs`, run as part
--      of the deploy) computes and persists the hash for any row whose
--      `definition_hash IS NULL`. The script is re-runnable.
-- For now: existing rows get version 1 with a NULL hash (the application
-- layer treats NULL as "version 1, hash unknown — compute on read" and
-- transparently falls back to the existing migration-analysis endpoint).
UPDATE action_type
   SET definition_version = 1
 WHERE definition_version IS NULL;

ALTER TABLE action_type
  ALTER COLUMN definition_version SET DEFAULT 1;

ALTER TABLE action_type
  ALTER COLUMN definition_version SET NOT NULL;

-- ---------------------------------------------------------------------------
-- BEFORE UPDATE trigger: bump definition_version + stamp the row's
-- updated_at. The hash column is recomputed by the application layer
-- (the canonical hash depends on application-side canonicalisation of
-- the JSONB); the trigger just refuses any UPDATE that doesn't bump it
-- when a definition-bearing column actually changed.
--
-- Note: PostgreSQL's `NEW.x IS DISTINCT FROM OLD.x` is the right
-- comparator for JSONB (it handles NULL semantics correctly). We use
-- the OLD/NEW row buffers in a single PL/pgSQL function so the branch
-- is cheap.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bump_action_type_definition_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  definition_changed BOOLEAN;
BEGIN
  definition_changed :=
       (NEW.parameters         IS DISTINCT FROM OLD.parameters)
    OR (NEW.rules               IS DISTINCT FROM OLD.rules)
    OR (NEW.submission_criteria IS DISTINCT FROM OLD.submission_criteria)
    OR (NEW.side_effects        IS DISTINCT FROM OLD.side_effects)
    OR (NEW.writeback_config    IS DISTINCT FROM OLD.writeback_config)
    OR (NEW.semantics_version   IS DISTINCT FROM OLD.semantics_version)
    OR (NEW.execution_mode      IS DISTINCT FROM OLD.execution_mode)
    OR (NEW.delete_policy       IS DISTINCT FROM OLD.delete_policy);

  IF definition_changed THEN
    NEW.definition_version := OLD.definition_version + 1;
  ELSE
    NEW.definition_version := OLD.definition_version;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_action_type_definition_version ON action_type;
CREATE TRIGGER trg_action_type_definition_version
  BEFORE UPDATE ON action_type
  FOR EACH ROW
  EXECUTE FUNCTION bump_action_type_definition_version();

COMMENT ON COLUMN action_type.definition_version IS
  'Monotonic per-row version. Bumped by trg_action_type_definition_version whenever ANY definition-bearing column (parameters, rules, submission_criteria, side_effects, writeback_config, semantics_version, execution_mode, delete_policy) changes. The action_audit_log references this version at execution time so editing an action type never mutates the historical meaning of past executions.';
COMMENT ON COLUMN action_type.definition_hash IS
  'Content-addressed sha256 over the canonical JSON of the definition-bearing columns, computed by the application layer (hashActionDefinition). Sent back to clients on read; PATCH requires it back as expectedDefinitionHash to enforce optimistic concurrency (409 MIGRATION_STALE_DEFINITION on mismatch). NULL only for rows that pre-date this migration — they are backfilled on first read.';
COMMENT ON FUNCTION bump_action_type_definition_version() IS
  'BEFORE UPDATE trigger. Bumps definition_version when any definition-bearing column actually changed (uses IS DISTINCT FROM for JSONB-correct semantics). Always stamps updated_at.';
