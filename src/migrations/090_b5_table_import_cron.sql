-- B5 — Foundry-parity scheduling: cron expressions + timezone for table imports.
--
-- Adds cron + timezone alongside the existing interval cadence so a sync can run
-- on a cron schedule (e.g. "0 9 * * 1-5" at 09:00 in a given IANA timezone),
-- matching Foundry's Build schedules. The actual triggering is driven by a
-- durable Temporal Schedule per import (see imports/temporal/schedule.ts);
-- these columns are the source of truth the schedule is (re)synced from.
--
--   schedule_cron       cron expression (5-7 field). NULL = interval/manual.
--   schedule_timezone   IANA timezone for cron evaluation (default UTC).
--
-- A cron schedule and an interval schedule are mutually exclusive.

ALTER TABLE table_imports
  ADD COLUMN IF NOT EXISTS schedule_cron text,
  ADD COLUMN IF NOT EXISTS schedule_timezone text;

-- cron XOR interval.
ALTER TABLE table_imports
  DROP CONSTRAINT IF EXISTS table_imports_schedule_mode_chk;
ALTER TABLE table_imports
  ADD CONSTRAINT table_imports_schedule_mode_chk
  CHECK (schedule_cron IS NULL OR schedule_interval_minutes IS NULL);

-- An enabled schedule must carry a cron OR (an interval + a computed next-run).
-- (cron schedules are driven by Temporal, which owns next-fire computation, so
-- next_run_at may be NULL for them.)
ALTER TABLE table_imports
  DROP CONSTRAINT IF EXISTS table_imports_schedule_enabled_chk;
ALTER TABLE table_imports
  ADD CONSTRAINT table_imports_schedule_enabled_chk
  CHECK (
    schedule_enabled = false
    OR schedule_cron IS NOT NULL
    OR (schedule_interval_minutes IS NOT NULL AND next_run_at IS NOT NULL)
  );
