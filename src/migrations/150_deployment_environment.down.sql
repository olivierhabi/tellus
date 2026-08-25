-- Rollback for 150_deployment_environment.sql.
-- WARNING: dropping these columns removes split-brain provenance from
-- existing rows. Only run this while diagnosing the migration itself.
ALTER TABLE funnel_state
    DROP COLUMN IF EXISTS active_run_started_at,
    DROP COLUMN IF EXISTS active_run_id,
    DROP COLUMN IF EXISTS environment_id;

DROP INDEX IF EXISTS idx_funnel_run_environment;

ALTER TABLE funnel_run
    DROP COLUMN IF EXISTS temporal_run_id,
    DROP COLUMN IF EXISTS environment_id;

DROP TABLE IF EXISTS deployment_environment;
