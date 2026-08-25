DROP TABLE IF EXISTS function_registry_function_version;
DROP TABLE IF EXISTS function_registry_function;
DROP TABLE IF EXISTS jemma_run_log;
DROP TABLE IF EXISTS function_publish_request;
DROP INDEX IF EXISTS jemma_run_history_idx;
ALTER TABLE jemma_run DROP COLUMN IF EXISTS lease_expires_at;
ALTER TABLE jemma_run DROP COLUMN IF EXISTS lease_owner;
ALTER TABLE jemma_run DROP COLUMN IF EXISTS job_name;
