-- Reverse of 130_action_writeback_config.sql

ALTER TABLE IF EXISTS action_type
  DROP CONSTRAINT IF EXISTS action_type_writeback_config_shape;

ALTER TABLE IF EXISTS action_type
  DROP CONSTRAINT IF EXISTS action_type_writeback_config_is_object;

ALTER TABLE IF EXISTS action_type
  DROP COLUMN IF EXISTS writeback_config;
