-- ---------------------------------------------------------------------------
-- Task PB-B5 — Streaming pipelines via Flink + ThroughputGuard.
--
-- pipelines.streaming_runtime     — selector ('flink' today, 'kafka_streams'
--                                   reserved). NULL for batch pipelines.
-- pipelines.streaming_parallelism — max parallel subtasks; capped at 16
--                                   (hard) via code-side guard.
-- pipelines.streaming_throughput_mbps
--                                  — optional override of the 2 MB/s
--                                   per-pipeline default cap; admin-only.
--                                   Hard ceiling 50 MB/s in code.
--
-- pipeline_deployments.flink_job_id  — Flink job ID set at submit.
-- pipeline_deployments.savepoint_path — S3 savepoint path written on
--                                   DELETE (stop --savepoint) and
--                                   consumed by restart.
-- pipeline_deployments.status CHECK is replaced so streaming states
-- ('running_streaming','draining') are valid. Existing rows keep
-- whatever enum they had; the new check is a superset.
-- ---------------------------------------------------------------------------

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS streaming_runtime TEXT;

ALTER TABLE pipelines
    DROP CONSTRAINT IF EXISTS pipelines_streaming_runtime_check;

ALTER TABLE pipelines
    ADD CONSTRAINT pipelines_streaming_runtime_check
    CHECK (streaming_runtime IS NULL OR streaming_runtime IN ('flink', 'kafka_streams'));

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS streaming_parallelism INTEGER;

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS streaming_throughput_mbps INTEGER;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS flink_job_id TEXT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS savepoint_path TEXT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS streaming_runtime TEXT;

-- Replace the status CHECK. We normalise any legacy out-of-set values
-- first so the ALTER succeeds, then install the superset.
UPDATE pipeline_deployments
    SET status = 'failed'
  WHERE status NOT IN ('running', 'succeeded', 'failed', 'cancelled',
                       'running_streaming', 'draining');

ALTER TABLE pipeline_deployments
    DROP CONSTRAINT IF EXISTS pipeline_deployments_status_check;

ALTER TABLE pipeline_deployments
    ADD CONSTRAINT pipeline_deployments_status_check
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled',
                      'running_streaming', 'draining'));

CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_streaming
    ON pipeline_deployments (pipeline_id, flink_job_id)
    WHERE flink_job_id IS NOT NULL;
