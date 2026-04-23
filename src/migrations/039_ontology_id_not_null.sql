-- ---------------------------------------------------------------------------
-- Migration 039: ontology_id NOT NULL + FK on edit tables
--
-- Closes F-P4-27 — tenant column nullability. `ontology_edit.ontology_id`
-- was nullable and not FK-constrained; `link_edit` had no ontology_id
-- column at all. Cross-ontology edits could be fabricated at ingest.
--
-- Two-phase migration contract:
--   Phase 1 (this file, online) — add the column to link_edit if missing,
--   backfill NULLs on both edit tables to a synthetic `main` ontology,
--   add the FK reference, then promote to NOT NULL.
--   Phase 2 (follow-up 040_*) — add CHECK constraints and the composite
--   indices that the tenant-scoped read path will rely on.
--
-- Synthetic `main` ontology: inserted once if not already present.
-- UUID is deterministic so re-runs are idempotent.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 039.1 Ensure the synthetic `main` ontology exists for backfill.
-- ---------------------------------------------------------------------------
INSERT INTO ontology (ontology_id, api_name, display_name, description, created_at, created_by)
VALUES (
  'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid,
  '__main_synthetic__',
  'Synthetic Main Ontology (backfill anchor)',
  'F-P4-27 backfill anchor for rows whose original ontology_id was NULL. Never delete.',
  now(),
  'migration-039'
)
ON CONFLICT (ontology_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 039.2 link_edit — add ontology_id if missing, backfill, constrain.
-- ---------------------------------------------------------------------------
ALTER TABLE link_edit
  ADD COLUMN IF NOT EXISTS ontology_id UUID;

UPDATE link_edit
   SET ontology_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
 WHERE ontology_id IS NULL;

ALTER TABLE link_edit
  ALTER COLUMN ontology_id SET NOT NULL;

ALTER TABLE link_edit
  ADD CONSTRAINT link_edit_ontology_fk
  FOREIGN KEY (ontology_id) REFERENCES ontology(ontology_id);

CREATE INDEX IF NOT EXISTS idx_link_edit_ontology
  ON link_edit(ontology_id, link_type_api_name);

-- ---------------------------------------------------------------------------
-- 039.3 ontology_edit — backfill + promote to NOT NULL.
-- ---------------------------------------------------------------------------
UPDATE ontology_edit
   SET ontology_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
 WHERE ontology_id IS NULL;

ALTER TABLE ontology_edit
  ALTER COLUMN ontology_id SET NOT NULL;

-- Add FK if not already present (earlier migrations may have omitted it).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'ontology_edit'
       AND constraint_name = 'ontology_edit_ontology_fk'
  ) THEN
    ALTER TABLE ontology_edit
      ADD CONSTRAINT ontology_edit_ontology_fk
      FOREIGN KEY (ontology_id) REFERENCES ontology(ontology_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ontology_edit_ontology
  ON ontology_edit(ontology_id, object_type_api_name);

COMMIT;
