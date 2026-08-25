-- ---------------------------------------------------------------------------
-- Migration 122 — Canonical Active Relationship Projection (link_instances)
--
-- Until now the only record of an M2M relationship was the append-only
-- `link_edit` ledger (add/remove operations). Referential-integrity checks
-- had to replay the WHOLE ledger to derive current active state:
--
--     SELECT ... SUM(CASE WHEN op='add' THEN 1 ELSE -1 END) ... HAVING net > 0
--
-- This is an unbounded scan. Version-2 deletion (`restrict`) needs an
-- efficient EXISTS check + aggregate counts with no full ledger replay.
--
-- This migration introduces `link_instances` as a materialised projection
-- of the CURRENT active relationship state:
--   * Each row = one active (non-deleted) relationship edge.
--   * Required uniqueness prevents duplicate active edges per cardinality.
--   * Lookup indexes support inbound/outbound/edge-existence queries.
--
-- `link_edit` stays the immutable edit ledger. `link_instances` is rebuilt
-- from the ledger once (idempotently) and then maintained incrementally by
-- the edit applicator on add/remove (Phase 6). FK-backed relationships are
-- NOT stored here — they are queried from `object_instances` using indexed
-- relationship-property columns (see §5; indexes added where necessary and
-- verified with EXPLAIN ANALYZE in the live environment).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_instances (
    link_instance_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- UUID to match link_edit.ontology_id / branch_id (migrations 039/040),
    -- so the projection is FK-joinable to the ledger.
    ontology_id         UUID        NOT NULL,
    branch_id           UUID        NOT NULL,
    link_type_api_name  TEXT        NOT NULL,
    source_object_type  TEXT        NOT NULL,
    source_primary_key  TEXT        NOT NULL,
    target_object_type  TEXT        NOT NULL,
    target_primary_key  TEXT        NOT NULL,
    -- Monotonic update metadata so readers can detect staleness vs the ledger.
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Provenance: the most recent link_edit execution that touched this edge.
    last_execution_id   UUID,
    UNIQUE (ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key)
);

-- Required lookup indexes (§5). These are the EXACT access paths used by the
-- referential-integrity EXISTS/aggregate checks during version-2 deletes.
CREATE INDEX IF NOT EXISTS idx_link_instances_src
    ON link_instances(ontology_id, branch_id, source_object_type, source_primary_key)
    WHERE source_object_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_link_instances_tgt
    ON link_instances(ontology_id, branch_id, target_object_type, target_primary_key)
    WHERE target_object_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_link_instances_edge
    ON link_instances(ontology_id, branch_id, link_type_api_name, source_primary_key, target_primary_key);

COMMENT ON TABLE link_instances IS
  'Materialised projection of the current active relationship state, rebuilt from link_edit and maintained incrementally on add/remove. FK-backed relationships are NOT stored here (query object_instances).';
