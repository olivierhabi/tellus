-- Reverse migration 173.
ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_security_settings_shape_chk;
ALTER TABLE action_type
  DROP COLUMN IF EXISTS security_settings;
