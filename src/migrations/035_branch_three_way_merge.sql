-- ---------------------------------------------------------------------------
-- F-04: Three-way merge infrastructure for ontology branches
--
-- Adds columns required for COW branching:
--   1. fork_point_edit_id on ontology_branch — records the latest edit_id
--      at the time the branch was forked.
--   2. ontology_id_fk on ontology_edit — associates edits with an ontology
--      for parent-side edit retrieval during merge.
--   3. Index on ontology_edit(branch_id) for efficient branch-scoped queries.
-- ---------------------------------------------------------------------------

-- fork_point_edit_id: the last edit_id on the parent at fork time
ALTER TABLE ontology_branch
  ADD COLUMN IF NOT EXISTS fork_point_edit_id UUID DEFAULT NULL;

-- ontology_id_fk on ontology_edit for parent-side queries
ALTER TABLE ontology_edit
  ADD COLUMN IF NOT EXISTS ontology_id_fk UUID DEFAULT NULL;

-- Index for branch-scoped edit queries
CREATE INDEX IF NOT EXISTS idx_ontology_edit_branch
  ON ontology_edit(branch_id)
  WHERE branch_id IS NOT NULL;

-- Index for parent-side edit queries during merge
CREATE INDEX IF NOT EXISTS idx_ontology_edit_ontology_fk
  ON ontology_edit(ontology_id_fk)
  WHERE ontology_id_fk IS NOT NULL;
