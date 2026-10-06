-- 193_merge_bucket_checkpoints.sql
--
-- Phase 2 (indexing merge architecture): per-bucket checkpoints for the
-- hash-partitioned merge. Each bucket writes its own source_state parquet;
-- a completed bucket is never recomputed — a failure costs one bucket, not
-- the whole run. Resume is keyed by run_key (the Temporal signal id); runs
-- without a run key process buckets locally with no checkpoint rows.
--
-- status is 'completed' only. Rows are written AFTER the bucket output is
-- durable (uploaded to MinIO, or present locally), never before. There is no
-- 'running' state: a crashed bucket simply has no row and is recomputed.

CREATE TABLE IF NOT EXISTS funnel_merge_bucket (
  run_key     TEXT        NOT NULL,
  bucket_id   INTEGER     NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'completed'
                CHECK (status = 'completed'),
  row_count   BIGINT      NOT NULL,
  checksum    TEXT,
  output_key  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_key, bucket_id)
);
