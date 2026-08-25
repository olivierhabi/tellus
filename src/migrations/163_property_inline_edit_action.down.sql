-- Rollback: remove the inline-edit action binding column from property.
ALTER TABLE property
  DROP COLUMN IF EXISTS inline_edit_action_id;
