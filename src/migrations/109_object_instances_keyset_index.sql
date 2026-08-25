-- ---------------------------------------------------------------------------
-- 109: keyset-pagination index for syncObjectInstancesToOpenSearch
--
-- The OpenSearch sync (syncFromInstances.ts) reads `object_instances` in
-- keyset pages: `WHERE object_type_api_name = $1 AND primary_key > $last
-- ORDER BY primary_key LIMIT $page`. Without an index on
-- `(object_type_api_name, primary_key)` this did a Parallel Index Scan of
-- EVERY row for the OT (via `idx_object_instances_ot`, which is on
-- `object_type_api_name` alone) followed by an external-merge Sort on disk
-- — ~6.1s per 5000-row page, ~17min for an 848k OT, which exceeded the
-- `syncOpenSearchActivity` startToCloseTimeout and caused the workflow to
-- time out + retry from zero. (The prior LIMIT/OFFSET paging had the same
-- per-page sort cost but it was masked by an even costlier per-page
-- `indices.refresh()`.)
--
-- This composite index turns the keyset page into an O(limit) index range
-- scan — no sort, no disk spill — dropping the page cost to ~ms and the
-- full 848k sync into the activity's timeout budget.
--
-- Revertible: `DROP INDEX IF EXISTS idx_object_instances_ot_pk;`
-- Idempotent: `CREATE INDEX IF NOT EXISTS`.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_object_instances_ot_pk
  ON object_instances (object_type_api_name, primary_key);
