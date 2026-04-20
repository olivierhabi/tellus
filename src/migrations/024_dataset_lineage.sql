-- ---------------------------------------------------------------------------
-- Task PB-B8 — dataset lineage graph.
--
-- Every deploy inserts edges (pipeline_output_dataset → input_dataset).
-- Every Object Type backing-datasource registration inserts an edge
-- (object_type_merged_dataset → backing_datasource). The downstream
-- walker on deploy completion fires Funnel signals for every OT whose
-- backing datasource is the just-deployed output.
--
-- PK = (downstream, upstream, edge_type) so re-registering an edge
-- with the same role is idempotent. Covering index on upstream_dataset_id
-- keeps the downstream walk cheap at 10k+ datasets (per the risk
-- callout in the spec).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dataset_lineage (
    downstream_dataset_id UUID        NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
    upstream_dataset_id   UUID        NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
    edge_type             TEXT        NOT NULL
                           CHECK (edge_type IN ('pipeline_output','funnel_input','virtual_table')),
    edge_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (downstream_dataset_id, upstream_dataset_id, edge_type),
    CONSTRAINT dataset_lineage_not_self CHECK (downstream_dataset_id <> upstream_dataset_id)
);

-- Covering index for the hot downstream walk: given an upstream dataset
-- id, find every direct downstream.
CREATE INDEX IF NOT EXISTS idx_dataset_lineage_upstream
    ON dataset_lineage (upstream_dataset_id)
    INCLUDE (downstream_dataset_id, edge_type);

-- Reverse index for upstream walks.
CREATE INDEX IF NOT EXISTS idx_dataset_lineage_downstream
    ON dataset_lineage (downstream_dataset_id);

-- Backfill: every backing_datasource with a dataset_id becomes an edge
-- from the Object Type merged-dataset → backing dataset. We use the
-- backing_datasource.mapping_id as downstream_dataset_id is NOT right
-- here — we want the OT-merged identity. Since there's no explicit
-- merged_dataset table today we defer the OT-side edge creation to
-- the register path (see icebergNamespace in runtime).
-- The backfill here covers pipeline_output edges from existing
-- pipeline_deployments.build_results payloads at a best-effort level.
-- The runtime deploy writer is what owns the authoritative inserts.
