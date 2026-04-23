-- ---------------------------------------------------------------------------
-- Migration 041: Extend object_instances primary key with branch_id
--
-- Closes F-P3-13 schema half — `object_instances` PK is
-- `(ontology_id, object_type_api_name, primary_key)` with NO branch
-- segment, so two branches writing the same object key collide.
-- Extending the PK to include `branch_id` is the minimally-invasive
-- fix: the key becomes
--   (ontology_id, branch_id, object_type_api_name, primary_key)
-- which gives every branch its own row even for the same object.
--
-- Offline-only: changing a PRIMARY KEY requires DROP + CREATE. Postgres
-- takes an ACCESS EXCLUSIVE lock on the table for the duration. Under
-- load this will block writes. Deploy sequence:
--
--   1. Stop Tellus write traffic (feature flag: BLOCK_WRITES=1).
--   2. Run migration 041.
--   3. Deploy new application code that reads/writes with branch_id.
--   4. Un-flag BLOCK_WRITES.
--
-- The runbook is in docs/BRANCHING.md §5. A zero-downtime variant
-- (creating a new table, copying data, swapping) is documented but not
-- implemented here — it is a Phase F item if downtime proves unacceptable.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 041.1 Add branch_id column if missing + backfill to `main` + NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE object_instances
  ADD COLUMN IF NOT EXISTS branch_id UUID;

-- Backfill to the row's ontology `main` branch.
UPDATE object_instances
   SET branch_id = (
     SELECT b.branch_id FROM ontology_branch b
      WHERE b.ontology_id = object_instances.ontology_id
        AND b.name = 'main'
      LIMIT 1
   )
 WHERE branch_id IS NULL;

ALTER TABLE object_instances
  ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE object_instances
  ADD CONSTRAINT object_instances_branch_fk
  FOREIGN KEY (branch_id) REFERENCES ontology_branch(branch_id);

-- ---------------------------------------------------------------------------
-- 041.2 Rebuild the primary key with branch_id as a segment.
-- ---------------------------------------------------------------------------
-- The current PK name is not canonical across environments — infer it.
DO $$
DECLARE
  pk_name TEXT;
BEGIN
  SELECT constraint_name INTO pk_name
    FROM information_schema.table_constraints
   WHERE table_name = 'object_instances'
     AND constraint_type = 'PRIMARY KEY'
   LIMIT 1;

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE object_instances DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE object_instances
  ADD CONSTRAINT object_instances_pkey
  PRIMARY KEY (ontology_id, branch_id, object_type_api_name, primary_key);

-- Also add a composite index on (branch_id, object_type_api_name) for
-- branch-scoped range scans — the most common access pattern.
CREATE INDEX IF NOT EXISTS idx_object_instances_branch_type
  ON object_instances(branch_id, object_type_api_name);

COMMIT;
