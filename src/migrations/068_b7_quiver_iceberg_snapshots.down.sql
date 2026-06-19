DROP INDEX IF EXISTS quiver_card_output_cache_iceberg_gin;
ALTER TABLE quiver_card_output_cache DROP COLUMN IF EXISTS mat_plan_json;
ALTER TABLE quiver_card_output_cache DROP COLUMN IF EXISTS mat_tier;
ALTER TABLE quiver_card_output_cache DROP COLUMN IF EXISTS result_blob_uri;
ALTER TABLE quiver_card_output_cache DROP COLUMN IF EXISTS iceberg_snapshots;
