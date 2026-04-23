-- Down migration 040 — revert branch_id enforcement on edit tables.
BEGIN;

DROP INDEX IF EXISTS idx_ontology_edit_branch;
ALTER TABLE ontology_edit DROP CONSTRAINT IF EXISTS ontology_edit_branch_fk;
ALTER TABLE ontology_edit ALTER COLUMN branch_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_link_edit_branch;
ALTER TABLE link_edit DROP CONSTRAINT IF EXISTS link_edit_branch_fk;
ALTER TABLE link_edit DROP COLUMN IF EXISTS branch_id;

-- Synthetic `main` branches retained. Purging them could orphan rows
-- still tagged with their ids. A separate cleanup migration can purge
-- once all references are gone.

COMMIT;
