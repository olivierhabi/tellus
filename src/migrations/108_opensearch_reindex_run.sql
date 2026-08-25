-- ---------------------------------------------------------------------------
-- Phase 3 (gap 2): PG-backed async + checkpointed + resumable OpenSearch
-- reindex run. Replaces the synchronous, blocking, restart-from-zero
-- `reindexObjectType` path for large CSV backings (feature-flagged via
-- FUNNEL_OPENSEARCH_PIPELINE).
--
-- Lifecycle: pending → running → indexed | failed.
--   * The Save/reindex POST INSERTs a 'pending' row and returns 202 + run_id
--     immediately (async) instead of awaiting the whole reindex inline.
--   * The executor streams the bounded externalHashMerge (Phase 1) and
--     bulk-indexes in batches, checkpointing `indexed_count` after each
--     batch flush. The merge is deterministic (stable CSV order + pure
--     hash + stable partition iteration), so on resume the executor
--     re-merges and SKIPS the first `indexed_count` already-indexed docs
--     (OpenSearch `index` by _id is idempotent) — it does NOT delete the
--     index and restart from zero.
--   * On worker/process restart, a boot sweeper re-queues orphaned
--     'running' rows (the repo's existing "auto-swept on boot" pattern).
--
-- This is single-worker, PG-durable resume — NOT Temporal multi-worker
-- durability (the dev cluster has one worker). Stated plainly in the
-- verdict.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opensearch_reindex_run (
  run_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id          UUID NOT NULL,
  object_type_api_name TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending|running|indexed|failed
  current_stage        TEXT,                             -- merge|indexing|done
  indexed_count        INTEGER NOT NULL DEFAULT 0,      -- checkpoint: docs indexed so far
  total_count          INTEGER,                         -- distinct count (filled after merge)
  duplicate_count      INTEGER NOT NULL DEFAULT 0,
  error_message        TEXT,
  triggered_by         TEXT NOT NULL DEFAULT 'manual',
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_opensearch_reindex_run_status
  ON opensearch_reindex_run (status);
CREATE INDEX IF NOT EXISTS idx_opensearch_reindex_run_ot
  ON opensearch_reindex_run (object_type_api_name);
