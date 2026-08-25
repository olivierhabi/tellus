-- Reverse of 132_action_type_definition_version.sql

DROP TRIGGER IF EXISTS trg_action_type_definition_version ON action_type;
DROP FUNCTION IF EXISTS bump_action_type_definition_version();

ALTER TABLE IF EXISTS action_type
  ALTER COLUMN definition_version DROP NOT NULL;

ALTER TABLE IF EXISTS action_type
  DROP COLUMN IF EXISTS definition_hash;
ALTER TABLE IF EXISTS action_type
  DROP COLUMN IF EXISTS definition_version;
