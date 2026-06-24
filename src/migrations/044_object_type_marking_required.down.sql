-- ---------------------------------------------------------------------------
-- Down migration for 044 — drop `marking_required` columns and indices.
--
-- Reversibility: this is a strict drop. Any data stored in
-- `marking_required` IS LOST. Operators running the down should snapshot
-- before executing.
-- ---------------------------------------------------------------------------

BEGIN;

DROP INDEX IF EXISTS idx_object_type_marking_gin;
ALTER TABLE object_type DROP COLUMN IF EXISTS marking_required;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'object_type_group') THEN
    EXECUTE 'DROP INDEX IF EXISTS idx_object_type_group_marking_gin';
    EXECUTE 'ALTER TABLE object_type_group DROP COLUMN IF EXISTS marking_required';
  END IF;
END
$$;

COMMIT;
