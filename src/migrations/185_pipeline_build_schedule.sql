-- Foundry Pipeline Builder parity — build schedules.
-- A pipeline with schedule_enabled=true is rebuilt by the pipeline build
-- scheduler (services/pipelines/buildScheduler.ts) every
-- schedule_interval_minutes, through the exact same startDeployment path as
-- a manual "Deploy". next_run_at is advanced atomically with the claim so
-- multi-replica boots never double-fire a window; a missed window schedules
-- ONE next run from now() (no backfill burst).
ALTER TABLE pipelines
  ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_interval_minutes integer,
  ADD COLUMN IF NOT EXISTS schedule_next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_last_run_at timestamptz;
