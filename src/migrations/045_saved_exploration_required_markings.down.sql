-- T-08 down migration: drop the marking columns + GIN indexes. Reversible.
-- The original `marking_required` columns + indexes are recreated by the
-- forward migration on the next `up` pass.

BEGIN;

DROP INDEX IF EXISTS idx_saved_exploration_markings_gin;
ALTER TABLE saved_exploration DROP COLUMN IF EXISTS required_markings;

DROP INDEX IF EXISTS idx_property_marking_gin;
ALTER TABLE property DROP COLUMN IF EXISTS marking_required;

COMMIT;
