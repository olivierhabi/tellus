-- Track 1 hardening (#4): transient-failure retry budget for
-- functions-publish runs. Retries reuse the SAME run row (one semantic
-- run, one log timeline); retry_count counts retries after the initial
-- attempt.
--
-- Additive and backward-compatible: existing rows read retry_count = 0.
-- On Postgres >= 11 a constant DEFAULT makes ADD COLUMN metadata-only
-- (no table rewrite). The CHECK mirrors the existing
-- jemma_run_resource_version_chk convention.
--
-- The ledger (schema_migrations_applied, keyed by filename) skips an
-- already-recorded migration, so this file normally executes once.
-- The constraint add below is additionally safe under any direct
-- re-application channel: it no-ops when the constraint already
-- exists WITH THE SAME definition, and fails loudly on a same-name,
-- different-definition constraint (never silently tolerated).

ALTER TABLE jemma_run
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

DO $$
DECLARE
  existing_def TEXT;
BEGIN
  SELECT pg_get_expr(c.conbin, c.conrelid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'jemma_run_retry_count_chk'
     AND c.conrelid = 'jemma_run'::regclass;
  IF FOUND THEN
    IF existing_def <> '(retry_count >= 0)' THEN
      RAISE EXCEPTION
        'jemma_run_retry_count_chk already exists with an unexpected definition: %',
        existing_def;
    END IF;
  ELSE
    ALTER TABLE jemma_run
      ADD CONSTRAINT jemma_run_retry_count_chk CHECK (retry_count >= 0);
  END IF;
END $$;
