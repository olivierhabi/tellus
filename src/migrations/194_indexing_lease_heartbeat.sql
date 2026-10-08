-- 194_indexing_lease_heartbeat.sql
--
-- Split the funnel_state indexing lock into two signals:
--   * lease_heartbeat_at — "holder process alive", written by the 5 s
--     holder timer (touchLeaseHeartbeat). The dead-process sweep owns it.
--   * last_progress_at   — "work advancing", written ONLY when rows/bytes
--     actually advance (migration 192). The stall watchdog owns it.
--
-- A bare timer must never move last_progress_at: that is what blinded the
-- stall watchdog to a hung native query.

ALTER TABLE funnel_state
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ;

-- Serves the dead-process sweep: all 'indexing' rows ordered by oldest heartbeat.
CREATE INDEX IF NOT EXISTS idx_funnel_state_lease_watch
  ON funnel_state(status, lease_heartbeat_at)
  WHERE status = 'indexing';
