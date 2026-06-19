-- 083_b1_connectivity_folder_fk.down.sql
--
-- Reverses 083_b1_connectivity_folder_fk.sql. Drops the canonical folder FK and
-- its supporting index. Idempotent via IF EXISTS so it is safe to run on any
-- database state.

DROP INDEX IF EXISTS idx_connectivity_connections_compass_folder_rid;

ALTER TABLE connectivity_connections
  DROP CONSTRAINT IF EXISTS connectivity_connections_compass_folder_rid_fkey;
