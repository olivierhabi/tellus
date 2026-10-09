-- 197_indexing_data_policy.down.sql — reverse of 197_indexing_data_policy.sql.

DROP TABLE IF EXISTS funnel_index_watermark;
ALTER TABLE object_type DROP CONSTRAINT IF EXISTS object_type_indexing_data_policy_check;
ALTER TABLE object_type DROP COLUMN IF EXISTS indexing_data_policy;
