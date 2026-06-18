-- ---------------------------------------------------------------------------
-- Migration 044 — `object_type.marking_required` and
--                 `object_type_group.marking_required`.
--
-- T-06: spec contract C-93/C-94. The `/summary` endpoint MUST exclude
-- object types whose `marking_required` is not a subset of the user's
-- marking set. Today the column does not exist; this migration adds it
-- with the conservative default (NULL = no requirement = visible to
-- all). Existing rows are unchanged.
--
-- A GIN index on `marking_required` is added so the `<@` (subset)
-- predicate stays fast as the catalog grows. The index uses array_ops,
-- which is the default for TEXT[] columns.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE object_type
  ADD COLUMN IF NOT EXISTS marking_required TEXT[];

CREATE INDEX IF NOT EXISTS idx_object_type_marking_gin
  ON object_type USING GIN (marking_required);

-- object_type_group may not exist on every deployment (it's a Phase 2
-- table introduced in migrate.ts). Guard the alter so this migration
-- is idempotent across both fresh and partial schemas.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'object_type_group') THEN
    EXECUTE 'ALTER TABLE object_type_group
               ADD COLUMN IF NOT EXISTS marking_required TEXT[]';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_object_type_group_marking_gin
               ON object_type_group USING GIN (marking_required)';
  END IF;
END
$$;

COMMIT;
