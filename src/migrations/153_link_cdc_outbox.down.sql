-- Reverse of 153_link_cdc_outbox.sql.
DROP INDEX IF EXISTS idx_link_cdc_outbox_link_type;
DROP INDEX IF EXISTS idx_link_cdc_outbox_dead;
DROP INDEX IF EXISTS idx_link_cdc_outbox_pending;
DROP TABLE IF EXISTS link_cdc_outbox;
