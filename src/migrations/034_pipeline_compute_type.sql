-- ---------------------------------------------------------------------------
-- Task PB-B2 — compute_type evolution.
--
-- The `pipelines` table already has a `compute_type` column whose CHECK
-- constraint accepts ('standard','lightweight','external'). PB-B2 changes
-- the meaning of this column so it selects the engine used by
-- TransformService — 'duckdb' (default going forward) vs 'legacy_nodejs'
-- (the pure-TS engine kept as a fallback for one release cycle).
--
-- Migration strategy:
--   1. Drop the old CHECK constraint (it references the pre-PB-B2 enum).
--   2. Set every existing pipeline to 'legacy_nodejs' so behaviour does
--      not change for chains that already ran green on the TS engine.
--   3. Add the new CHECK and flip the default to 'duckdb' so newly
--      created pipelines get the new engine.
--
-- Rollback path: `UPDATE pipelines SET compute_type='legacy_nodejs'`
-- switches everybody back to the TS engine without schema work.
-- ---------------------------------------------------------------------------

ALTER TABLE pipelines
    DROP CONSTRAINT IF EXISTS pipelines_compute_type_check;

UPDATE pipelines
    SET compute_type = 'legacy_nodejs'
  WHERE compute_type IS NULL
     OR compute_type IN ('standard', 'lightweight', 'external');

ALTER TABLE pipelines
    ALTER COLUMN compute_type SET DEFAULT 'duckdb';

ALTER TABLE pipelines
    ADD CONSTRAINT pipelines_compute_type_check
    CHECK (compute_type IN ('duckdb', 'legacy_nodejs'));
