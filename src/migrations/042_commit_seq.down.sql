-- Down migration 042 — revert commit_seq enforcement.
BEGIN;

DROP INDEX IF EXISTS idx_ontology_branch_fork_seq;
ALTER TABLE ontology_branch DROP COLUMN IF EXISTS fork_point_commit_seq;

DROP INDEX IF EXISTS idx_ontology_edit_branch_commit_seq;
DROP INDEX IF EXISTS idx_ontology_edit_commit_seq;

ALTER TABLE ontology_edit ALTER COLUMN commit_seq DROP NOT NULL;
ALTER TABLE ontology_edit ALTER COLUMN commit_seq DROP DEFAULT;
DROP SEQUENCE IF EXISTS ontology_edit_commit_seq;
ALTER TABLE ontology_edit DROP COLUMN IF EXISTS commit_seq;

COMMIT;
