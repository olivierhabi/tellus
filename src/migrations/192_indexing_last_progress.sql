-- 192_indexing_last_progress.sql
--
-- Phase 2 (indexing merge architecture): separate "process alive" from "work
-- moving" on the funnel_state indexing lock.
--
-- The lock's updated_at heartbeat lives on the JS main thread (stage
-- transitions). Phase 0 proved that heartbeat stays fresh through a
-- native-thread deadlock, so it cannot detect a stuck run — and its absence
-- during the 90-minute merge could not distinguish dead from stuck either.
-- last_progress_at is written ONLY when rows/bytes actually advance (merge
-- PG-tail batches, out-of-process prefix progress), so the stall watchdog
-- can fail a run that is alive but not moving.
--
-- Rule (enforced by indexingLease.ts, not by the schema):
--   * non-NULL + older than FUNNEL_INDEXING_STALL_AFTER_MS → STALLED;
--   * NULL → not instrumented → watchdog skips; boot reconciler owns it.

ALTER TABLE funnel_state
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ;

-- Serves the stall watchdog: all 'indexing' rows ordered by oldest progress.
CREATE INDEX IF NOT EXISTS idx_funnel_state_progress_watch
  ON funnel_state(status, last_progress_at)
  WHERE status = 'indexing';
