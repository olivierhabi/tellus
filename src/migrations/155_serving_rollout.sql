-- ---------------------------------------------------------------------------
-- 155 — Per-scope serving-store rollout flags (controlled cutover).
--
-- Rollout of the indexed ObjectServingStore / LinkServingStore is gated per
-- matchable scope, NEVER one global switch. Resolution order in
-- servingFlags.ts: capability → link_type → object_type → branch → ontology
-- → tenant → global env SERVING_STORE_MODE (default 'legacy'). Modes:
--   legacy  : existing serving path (rollback-safe default)
--   shadow  : run BOTH, compare canonicalized results, RETURN the legacy
--             result; mismatches are logged + metriced
--   indexed : return the serving-index result (only after backfill +
--             checksum pass evidenced by migration/cutover checks)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS serving_rollout (
    scope_kind    TEXT NOT NULL CHECK (scope_kind IN (
                    'tenant', 'ontology', 'branch', 'object_type',
                    'link_type', 'capability', 'global')),
    scope_key     TEXT NOT NULL,
    mode          TEXT NOT NULL CHECK (mode IN ('legacy', 'shadow', 'indexed')),
    rationale     TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_kind, scope_key)
);
