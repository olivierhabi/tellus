-- ---------------------------------------------------------------------------
-- Migration 042: monotonic commit_seq on ontology_edit
--
-- Closes the fork-point-selection half of F-P3-14. The current branch
-- merge algorithm uses `edit_id > $forkPointEditId` for UUID comparison,
-- which is non-deterministic (UUIDv4 is random; UUIDv7 is only partly
-- monotonic under clock skew). A monotonic `commit_seq BIGSERIAL` is
-- the correct primitive for fork-point identification: every INSERT
-- receives an ever-increasing sequence number, so "edits after fork point"
-- is well-defined.
--
-- Backfill: existing rows get commit_seq values in `created_at` order.
-- Ties on created_at broken by edit_id lexicographic order — arbitrary
-- but deterministic and stable across re-runs.
--
-- After the backfill, the BIGSERIAL default takes over for all new
-- inserts. The column is NOT NULL.
--
-- The `fork_point_commit_seq` column on ontology_branch is added here
-- too — replaces the current `fork_point_edit_id UUID` which has the
-- same non-monotonicity problem. Both columns coexist for the grace
-- period; 043 will drop `fork_point_edit_id` after the merge-service
-- rewrite migrates to the seq-based API.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- 042.1 Add commit_seq to ontology_edit.
-- ---------------------------------------------------------------------------
ALTER TABLE ontology_edit
  ADD COLUMN IF NOT EXISTS commit_seq BIGINT;

-- Backfill — order rows by executed_at and edit_id so re-runs are stable.
-- The ontology_edit table uses `executed_at` (not `created_at`) for its
-- authoritative timestamp column — see the inline schema in src/migrate.ts.
WITH numbered AS (
  SELECT edit_id,
         ROW_NUMBER() OVER (ORDER BY executed_at ASC, edit_id ASC) AS rn
    FROM ontology_edit
   WHERE commit_seq IS NULL
)
UPDATE ontology_edit oe
   SET commit_seq = numbered.rn
  FROM numbered
 WHERE oe.edit_id = numbered.edit_id;

-- Now take over for new inserts. Create a sequence starting after the
-- backfill's max so future INSERTs never collide.
CREATE SEQUENCE IF NOT EXISTS ontology_edit_commit_seq OWNED BY ontology_edit.commit_seq;
SELECT setval(
  'ontology_edit_commit_seq',
  COALESCE((SELECT MAX(commit_seq) + 1 FROM ontology_edit), 1),
  false
);

ALTER TABLE ontology_edit
  ALTER COLUMN commit_seq SET DEFAULT nextval('ontology_edit_commit_seq');

ALTER TABLE ontology_edit
  ALTER COLUMN commit_seq SET NOT NULL;

-- Unique index so `commit_seq` can be used as a stable cursor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_edit_commit_seq
  ON ontology_edit(commit_seq);

-- Composite index for branch-scoped fork-point queries.
CREATE INDEX IF NOT EXISTS idx_ontology_edit_branch_commit_seq
  ON ontology_edit(branch_id, commit_seq);

-- ---------------------------------------------------------------------------
-- 042.2 Add fork_point_commit_seq to ontology_branch.
--
-- Coexists with the legacy fork_point_edit_id column during the grace
-- period. The merge service reads fork_point_commit_seq preferentially;
-- old rows with NULL fork_point_commit_seq fall back to the legacy
-- column's edit_id → commit_seq translation in-application.
-- ---------------------------------------------------------------------------
ALTER TABLE ontology_branch
  ADD COLUMN IF NOT EXISTS fork_point_commit_seq BIGINT;

-- Backfill fork_point_commit_seq from existing fork_point_edit_id.
UPDATE ontology_branch b
   SET fork_point_commit_seq = oe.commit_seq
  FROM ontology_edit oe
 WHERE b.fork_point_edit_id = oe.edit_id
   AND b.fork_point_commit_seq IS NULL;

CREATE INDEX IF NOT EXISTS idx_ontology_branch_fork_seq
  ON ontology_branch(fork_point_commit_seq)
  WHERE fork_point_commit_seq IS NOT NULL;

COMMIT;
