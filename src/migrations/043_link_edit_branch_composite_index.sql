-- ---------------------------------------------------------------------------
-- Migration 043: composite (link_type_api_name, branch_id, executed_at DESC)
-- index on link_edit.
--
-- F-P3-12 closure: the cardinality enforcer in
-- `src/services/linkViolationEnforcer.ts` now runs
--
--   SELECT ... FROM link_edit
--    WHERE link_type_api_name = $1
--      AND (source_primary_key|target_primary_key) = $2
--      AND branch_id = $N
--      AND operation = 'add'
--    ORDER BY executed_at DESC
--    LIMIT 1
--
-- against every ONE_TO_ONE / ONE_TO_MANY add. Migration 040 added an
-- index on (branch_id, link_type_api_name) which is leading-column
-- wrong for the enforcer's predicate: the enforcer pins link_type first
-- and then filters by branch. This migration adds the composite that
-- matches the query pattern exactly, so the enforcement check is
-- O(log n) on a per-link-type + per-branch basis.
--
-- The 040 index is retained (used by administrative branch-scope
-- sweeps, not the hot path). Dropping it is deferred to a separate
-- cleanup migration once pg_stat_all_indexes confirms zero reads.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE INDEX IF NOT EXISTS idx_link_edit_type_branch_time
  ON link_edit (link_type_api_name, branch_id, executed_at DESC);

COMMIT;
