-- 196_merge_staging_unlogged.down.sql — reverse of 196_merge_staging_unlogged.sql.

ALTER TABLE IF EXISTS merge_staging_instances SET LOGGED;
