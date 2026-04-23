-- ---------------------------------------------------------------------------
-- Down migration 039 — revert ontology_id tenant enforcement.
--
-- WARNING: dropping the NOT NULL + FK constraints reverts rows written
-- after the up-migration into an enforcement-free state. Only safe to run
-- after redeploying application code that does not assume the constraint.
-- ---------------------------------------------------------------------------
BEGIN;

DROP INDEX IF EXISTS idx_ontology_edit_ontology;
ALTER TABLE ontology_edit DROP CONSTRAINT IF EXISTS ontology_edit_ontology_fk;
ALTER TABLE ontology_edit ALTER COLUMN ontology_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_link_edit_ontology;
ALTER TABLE link_edit DROP CONSTRAINT IF EXISTS link_edit_ontology_fk;
ALTER TABLE link_edit DROP COLUMN IF EXISTS ontology_id;

-- Synthetic `main` ontology is retained — removing it could orphan rows
-- still tagged with its id in other tables. A separate 040_* can purge
-- it after all references are gone.

COMMIT;
