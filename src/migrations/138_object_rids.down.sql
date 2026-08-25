-- Rollback for 138_object_rids.sql
DROP INDEX IF EXISTS idx_object_instances_rid;
ALTER TABLE object_instances DROP COLUMN IF EXISTS rid;
