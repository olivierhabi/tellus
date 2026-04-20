-- ---------------------------------------------------------------------------
-- Task PB-B4 — Iceberg outputs via Lakekeeper.
--
-- Columns:
--   pipelines.iceberg_partition_spec     JSONB — PyIceberg partition-spec
--                                         definitions validated at deploy.
--   pipeline_deployments.output_snapshot_id
--                                        BIGINT — snapshot appended by
--                                         this deploy. Nullable until
--                                         the commit lands so cancellation
--                                         of an in-flight append is safe.
--   pipeline_deployments.prior_snapshot_id
--                                        BIGINT — snapshot the table was
--                                         at *before* this deploy began.
--                                         Cancellation path issues
--                                         rollback_to_snapshot(prior) via
--                                         the PyIceberg sidecar.
--   pipeline_deployments.output_table_location
--                                        TEXT — warehouse/namespace/table
--                                         trio captured so cancellation
--                                         can find the table after a
--                                         partial deploy.
--   pipeline_deployments.iceberg_retry_count
--                                        INTEGER — OCC retry counter for
--                                         exponential-backoff observability.
--
-- Watermark:
--   pipeline_changelog_watermark — per-(pipeline_id, consumer) tuple so
--     downstream Funnel ingest can advance (last_from_snapshot,
--     last_to_snapshot) incrementally against the pipeline's Iceberg
--     changelog — same mental model as funnel_changelog_watermark.
-- ---------------------------------------------------------------------------

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS iceberg_partition_spec JSONB;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS output_snapshot_id BIGINT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS prior_snapshot_id BIGINT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS output_table_location TEXT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS iceberg_retry_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_snapshot
    ON pipeline_deployments (pipeline_id, output_snapshot_id)
    WHERE output_snapshot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pipeline_changelog_watermark (
    pipeline_id           UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    consumer              TEXT        NOT NULL,
    last_from_snapshot_id BIGINT,
    last_to_snapshot_id   BIGINT,
    last_advanced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_rows_emitted     BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (pipeline_id, consumer)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_changelog_watermark_consumer
    ON pipeline_changelog_watermark (consumer, last_advanced_at DESC);
