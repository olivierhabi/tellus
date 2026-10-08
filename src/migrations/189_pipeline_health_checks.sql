-- Pipeline Builder — per-dataset health checks (Data Health dialog).
-- A health check is a declarative assertion about a pipeline node's
-- dataset (build success, freshness, row count) surfaced in the FE as a
-- PASS / FAIL / UNKNOWN pill. Status is recorded as-known at creation
-- (UNKNOWN until an evaluator runs); CRUD mirrors pipeline_expectations.
CREATE TABLE IF NOT EXISTS pipeline_health_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  node_id      uuid REFERENCES pipeline_nodes(id) ON DELETE CASCADE,
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('build_success', 'freshness', 'row_count')),
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('PASS', 'FAIL', 'UNKNOWN')),
  detail       text,
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_health_checks_pipeline
  ON pipeline_health_checks (pipeline_id) WHERE active;
