-- B5 — Table-import scheduling.
--
-- Adds an automatic run cadence to table imports so a sync can run on a
-- recurring interval (not only manual "Run"). The cadence is a simple,
-- dependency-free interval in minutes; the connectivity scheduler claims due
-- rows (FOR UPDATE SKIP LOCKED) and enqueues a build through the same path as
-- a manual run. Overlapping runs are prevented by the single-active-build lock.
--
--   schedule_enabled          when true the scheduler considers this import
--   schedule_interval_minutes cadence in minutes (NULL when manual)
--   next_run_at               when the next automatic build is due (NULL=manual)
--   last_run_at               when the scheduler last enqueued a build
--   last_scheduled_build_rid  the most recent scheduler-triggered build

ALTER TABLE table_imports
  ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_interval_minutes int
    CHECK (schedule_interval_minutes IS NULL OR schedule_interval_minutes >= 1),
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_scheduled_build_rid text;

-- A schedule that is enabled must carry an interval and a next-run time.
ALTER TABLE table_imports
  DROP CONSTRAINT IF EXISTS table_imports_schedule_enabled_chk;
ALTER TABLE table_imports
  ADD CONSTRAINT table_imports_schedule_enabled_chk
  CHECK (
    schedule_enabled = false
    OR (schedule_interval_minutes IS NOT NULL AND next_run_at IS NOT NULL)
  );

-- The scheduler's hot path: "which enabled imports are due now?" A partial
-- index keyed on next_run_at keeps that scan cheap as the table grows.
CREATE INDEX IF NOT EXISTS table_imports_due_idx
  ON table_imports (next_run_at)
  WHERE schedule_enabled AND deleted_at IS NULL;
