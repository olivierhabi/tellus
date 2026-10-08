-- 194_indexing_lease_heartbeat.down.sql — reverse of 194_indexing_lease_heartbeat.sql.

DROP INDEX IF EXISTS idx_funnel_state_lease_watch;
ALTER TABLE funnel_state
  DROP COLUMN IF EXISTS lease_heartbeat_at;
