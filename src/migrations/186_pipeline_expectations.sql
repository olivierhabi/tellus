-- Foundry Pipeline Builder parity — data expectations on pipeline builds.
-- An expectation is a declarative data-quality rule evaluated against the
-- rows a build is ABOUT to publish: severity 'fail' blocks the build BEFORE
-- any transaction is committed (the upstream dataset stays untouched);
-- 'warn' records but lets the build through. Results land on the deployment
-- row so the health history of a pipeline answerable from
-- pipeline_deployments.expectation_results.
CREATE TABLE IF NOT EXISTS pipeline_expectations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id  uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  node_id      uuid REFERENCES pipeline_nodes(id) ON DELETE CASCADE,
  name         text NOT NULL,
  type         text NOT NULL CHECK (type IN ('row_count_bounds', 'not_null', 'unique')),
  config       jsonb NOT NULL,
  severity     text NOT NULL DEFAULT 'fail' CHECK (severity IN ('fail', 'warn')),
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_expectations_pipeline
  ON pipeline_expectations (pipeline_id) WHERE active;

ALTER TABLE pipeline_deployments
  ADD COLUMN IF NOT EXISTS expectation_results jsonb;
