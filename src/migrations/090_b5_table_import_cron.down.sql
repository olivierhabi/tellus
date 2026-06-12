-- Revert B5 cron scheduling columns.
ALTER TABLE table_imports DROP CONSTRAINT IF EXISTS table_imports_schedule_mode_chk;
ALTER TABLE table_imports
  DROP CONSTRAINT IF EXISTS table_imports_schedule_enabled_chk;
-- Restore the interval-only enabled check.
ALTER TABLE table_imports
  ADD CONSTRAINT table_imports_schedule_enabled_chk
  CHECK (
    schedule_enabled = false
    OR (schedule_interval_minutes IS NOT NULL AND next_run_at IS NOT NULL)
  );
ALTER TABLE table_imports DROP COLUMN IF EXISTS schedule_cron;
ALTER TABLE table_imports DROP COLUMN IF EXISTS schedule_timezone;
