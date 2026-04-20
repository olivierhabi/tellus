-- ---------------------------------------------------------------------------
-- Task PB-B6 — deterministic snapshot-pinned deploys.
--
-- Columns:
--   pipeline_deployments.input_snapshots     JSONB — per-input resolved
--       snapshot/version audit. Shape:
--         { "<nodeId>": {
--             "dataset_id": "<uuid>",
--             "upstream_snapshot_id": "<iceberg-int64 as string>",
--             "s3_version_id": "<string|null>",
--             "etag": "<string|null>",
--             "format": "iceberg|parquet|csv"
--           }, ... }
--   pipeline_deployments.divergence_warning  BOOLEAN — true when the
--       caller passed ?ignorePreviewSnapshot=true and the deploy ran
--       against the live upstream instead of the pinned preview.
--   pipeline_deployments.ignore_preview_snapshot BOOLEAN — audit flag
--       recording whether the caller requested the escape hatch.
--   pipeline_deployments.preview_chain_hash  TEXT — captured chain
--       hash at deploy time for post-hoc stale diagnosis.
-- ---------------------------------------------------------------------------

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS input_snapshots JSONB;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS divergence_warning BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS ignore_preview_snapshot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS preview_chain_hash TEXT;

-- Searchable index on the deploy-time snapshot record so an ops
-- engineer can correlate a dataset snapshot with the pipeline deploys
-- that consumed it (parallel to funnel_changelog_watermark lookups).
CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_divergence
    ON pipeline_deployments (pipeline_id)
    WHERE divergence_warning = TRUE;
