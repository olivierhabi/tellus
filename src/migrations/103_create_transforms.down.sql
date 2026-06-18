-- Reverse of 103_create_transforms.sql.
DROP TABLE IF EXISTS transform_lineage;
DROP TABLE IF EXISTS transform_build_event;
DROP TABLE IF EXISTS transform_build;
DROP INDEX IF EXISTS dataset_rid_uq;
ALTER TABLE dataset DROP COLUMN IF EXISTS rid;
