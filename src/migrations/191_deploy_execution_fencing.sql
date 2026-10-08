-- 191_deploy_execution_fencing.sql
--
-- Incident 3ec397d5 (2026-10-05): the Temporal pipelineDeployWorkflow
-- activity AND the PG pipeline dispatcher both executed the same deployment
-- concurrently (both call DeploymentService.executeDeploymentById; the
-- dispatcher's documented "Temporal preferred, handoff-only" protocol was
-- never implemented in tick()). No mutual exclusion existed anywhere:
-- executeDeploymentById's `status !== 'running'` re-check is a non-atomic
-- check-then-act (both executors read 'running' at start).
--
-- This migration adds the fencing schema. Enforcement lives in
-- DeploymentService.claimDeployment / executeDeploymentById:
--
--   claim: UPDATE pipeline_deployments
--            SET claimed_by=$worker, claimed_at=now(),
--                lease_expires_at=now()+$ttl
--          WHERE id=$id AND (claimed_by IS NULL OR lease_expires_at < now())
--            AND status IN ('running','running_streaming')
--          RETURNING *;
--   No row returned => another executor owns it => exit silently.
--
-- DESIGN (deliberate): deployments keep being INSERTed with status='running'
-- (the POST /deploy contract and every status reader depend on it); the
-- claim is carried by the new columns, not by a new 'queued' state. Rows
-- with claimed_by IS NULL (all pre-migration rows, including stuck ones)
-- are immediately claimable, which is also the recovery path.
--
-- pipeline_deploy_output_registrations gives exactly-one registration per
-- (deployment, output node): written with INSERT ... ON CONFLICT DO NOTHING.
-- node_id/dataset_id are deliberately NOT hard FKs to pipeline_nodes /
-- foundry_datasets: nodes are routinely deleted/recreated by canvas edits
-- and datasets by retention sweeps; the registration row is an audit trail
-- owned by the deployment (CASCADE on deployment delete).

ALTER TABLE pipeline_deployments
  ADD COLUMN IF NOT EXISTS claimed_by text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Serves the lease-recovery sweep: running deployments whose lease expired
-- (or pre-migration rows that were never claimed).
CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_lease_expiry
  ON pipeline_deployments (lease_expires_at)
  WHERE status IN ('running', 'running_streaming');

CREATE TABLE IF NOT EXISTS pipeline_deploy_output_registrations (
  deployment_id uuid NOT NULL REFERENCES pipeline_deployments(id) ON DELETE CASCADE,
  node_id       uuid NOT NULL,
  dataset_id    uuid NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_deploy_output_reg_dataset
  ON pipeline_deploy_output_registrations (dataset_id);
