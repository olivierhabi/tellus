ALTER TABLE pipelines
  DROP COLUMN IF EXISTS schedule_enabled,
  DROP COLUMN IF EXISTS schedule_interval_minutes,
  DROP COLUMN IF EXISTS schedule_next_run_at,
  DROP COLUMN IF EXISTS schedule_last_run_at;
