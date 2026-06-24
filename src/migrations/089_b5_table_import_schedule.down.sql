-- Down: drop table-import scheduling.
DROP INDEX IF EXISTS table_imports_due_idx;
ALTER TABLE table_imports
  DROP CONSTRAINT IF EXISTS table_imports_schedule_enabled_chk;
ALTER TABLE table_imports
  DROP COLUMN IF EXISTS schedule_enabled,
  DROP COLUMN IF EXISTS schedule_interval_minutes,
  DROP COLUMN IF EXISTS next_run_at,
  DROP COLUMN IF EXISTS last_run_at,
  DROP COLUMN IF EXISTS last_scheduled_build_rid;
