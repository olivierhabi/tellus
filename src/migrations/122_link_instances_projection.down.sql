-- Reverse migration for 122_link_instances_projection.sql.
DROP INDEX IF EXISTS idx_link_instances_edge;
DROP INDEX IF EXISTS idx_link_instances_tgt;
DROP INDEX IF EXISTS idx_link_instances_src;
DROP TABLE IF EXISTS link_instances;
