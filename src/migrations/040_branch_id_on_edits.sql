-- ---------------------------------------------------------------------------
-- Migration 040: branch_id NOT NULL on edit tables
--
-- Closes the schema half of F-P3-12 — `link_edit` has no branch column.
-- Also tightens `ontology_edit.branch_id` (added in migration 035 as
-- nullable) to NOT NULL with an FK reference.
--
-- Phased approach to avoid blocking writes:
--
--   Phase 1 (this file) — ensure `main` branch exists; add branch_id
--   column to link_edit if missing; backfill NULLs on both tables to
--   `main`; add FK; promote to NOT NULL.
--
--   Phase 2 (041_*) — extend object_instances PK to include branch_id
--   OR materialize per-branch physical views. Choice documented in
--   docs/BRANCHING.md. This file does NOT touch object_instances.
--
-- Synthetic `main` branch: the default branch for every ontology. Each
-- ontology gets exactly one `main`. UUID derived from ontology_id so
-- backfill is deterministic.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 040.1 Ensure every ontology has a `main` branch.
--
-- Relies on the ontology_branch table schema defined in earlier migrations.
-- If a given ontology has no branch record, we synthesize one with a
-- deterministic UUID (uuid_generate_v5 of the ontology_id + literal 'main')
-- so the generated UUID is stable across re-runs.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- status='OPEN' matches the `ontology_branch_status_check` constraint
-- installed with the table (OPEN | MERGED | CLOSED). The earlier draft
-- of this migration used 'active' which would have violated the check
-- had any ontology existed at migration time; it only ran clean because
-- fresh DBs have zero rows in `ontology` when 040 applies.
INSERT INTO ontology_branch (branch_id, ontology_id, name, status, created_at, created_by, fork_point_edit_id)
SELECT
  uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, ontology_id::text || ':main'),
  ontology_id,
  'main',
  'OPEN',
  now(),
  'migration-040',
  NULL
FROM ontology
WHERE NOT EXISTS (
  SELECT 1 FROM ontology_branch b
   WHERE b.ontology_id = ontology.ontology_id
     AND b.name = 'main'
);

-- ---------------------------------------------------------------------------
-- 040.2 link_edit — add branch_id column if missing + backfill + NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE link_edit
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Backfill NULL branch_ids to the row's ontology_id's `main` branch.
-- (039 ensured ontology_id is populated, so this two-step join works.)
UPDATE link_edit
   SET branch_id = (
     SELECT b.branch_id FROM ontology_branch b
      WHERE b.ontology_id = link_edit.ontology_id
        AND b.name = 'main'
      LIMIT 1
   )
 WHERE branch_id IS NULL;

ALTER TABLE link_edit
  ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE link_edit
  ADD CONSTRAINT link_edit_branch_fk
  FOREIGN KEY (branch_id) REFERENCES ontology_branch(branch_id);

CREATE INDEX IF NOT EXISTS idx_link_edit_branch
  ON link_edit(branch_id, link_type_api_name);

-- ---------------------------------------------------------------------------
-- 040.3 ontology_edit — promote branch_id to NOT NULL + FK.
-- ---------------------------------------------------------------------------
-- Backfill on ontology_edit identically.
UPDATE ontology_edit
   SET branch_id = (
     SELECT b.branch_id FROM ontology_branch b
      WHERE b.ontology_id = ontology_edit.ontology_id
        AND b.name = 'main'
      LIMIT 1
   )
 WHERE branch_id IS NULL;

ALTER TABLE ontology_edit
  ALTER COLUMN branch_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'ontology_edit' AND constraint_name = 'ontology_edit_branch_fk'
  ) THEN
    ALTER TABLE ontology_edit
      ADD CONSTRAINT ontology_edit_branch_fk
      FOREIGN KEY (branch_id) REFERENCES ontology_branch(branch_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ontology_edit_branch
  ON ontology_edit(branch_id, object_type_api_name);

COMMIT;
