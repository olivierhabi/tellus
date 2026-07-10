-- ===========================================================================
-- Migration 105 — Data branching: branch column on dataset_transaction.
--
-- Branch-scoped input resolution + snapshot isolation. A build on branch A
-- reads A's committed transactions (resolveDatasetByRid filters
-- branch=$2 OR branch IS NULL for legacy pre-branching rows), and a SNAPSHOT
-- on branch A supersedes only A's prior txs (not sibling branch B's) — so
-- pipeline experimentation is isolated per Foundry's data-branching model.
-- ===========================================================================

ALTER TABLE dataset_transaction ADD COLUMN IF NOT EXISTS branch TEXT;

-- Branch-scoped latest-tx lookup (resolveDatasetByRid) + previous-tx lookup
-- (resolvePreviousTransaction, OFFSET 1) — both filter (dataset_id, branch,
-- committed_at DESC) over committed txs.
CREATE INDEX IF NOT EXISTS dataset_transaction_branch_idx
  ON dataset_transaction (dataset_id, branch, committed_at DESC NULLS LAST)
  WHERE status = 'committed';
