-- 157 rollback.
DROP TABLE IF EXISTS link_edge_watermarks;
DROP INDEX IF EXISTS idx_link_cdc_outbox_seq;
ALTER TABLE link_cdc_outbox DROP COLUMN IF EXISTS outbox_seq;
