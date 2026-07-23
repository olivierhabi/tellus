-- Persist the metadata authored by the Ontology Manager action-type wizard.
-- Nullable/defaulted columns keep existing action types and API clients fully
-- backward compatible while making icon and Compass placement first-class.
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS icon_name TEXT DEFAULT 'manually-entered-data',
  ADD COLUMN IF NOT EXISTS icon_color TEXT DEFAULT '#1A2230',
  ADD COLUMN IF NOT EXISTS save_location_rid TEXT DEFAULT NULL;

ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_icon_color_format;

ALTER TABLE action_type
  ADD CONSTRAINT action_type_icon_color_format
  CHECK (icon_color IS NULL OR icon_color ~ '^#[0-9A-Fa-f]{6}$');

COMMENT ON COLUMN action_type.save_location_rid IS
  'Compass project/folder RID selected when the action type is created.';
