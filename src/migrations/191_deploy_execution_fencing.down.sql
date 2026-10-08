-- 191_deploy_execution_fencing.down.sql — reverse of 191_deploy_execution_fencing.sql.
DROP TABLE IF EXISTS pipeline_deploy_output_registrations;
DROP INDEX IF EXISTS idx_pipeline_deployments_lease_expiry;
ALTER TABLE pipeline_deployments
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS claimed_by;
