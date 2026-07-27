-- Reverse of 131_side_effect_outbox.sql

DROP INDEX IF EXISTS idx_action_side_effect_job_dead;
DROP INDEX IF EXISTS idx_action_side_effect_job_action_status;
DROP INDEX IF EXISTS idx_action_side_effect_job_execution;
DROP INDEX IF EXISTS idx_action_side_effect_job_claim;

DROP TABLE IF EXISTS action_side_effect_job;
