ALTER TABLE jemma_run
  DROP CONSTRAINT IF EXISTS jemma_run_retry_count_chk;

ALTER TABLE jemma_run
  DROP COLUMN IF EXISTS retry_count;
