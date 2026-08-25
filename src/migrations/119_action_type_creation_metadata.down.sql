ALTER TABLE action_type DROP CONSTRAINT IF EXISTS action_type_icon_color_format;
ALTER TABLE action_type
  DROP COLUMN IF EXISTS save_location_rid,
  DROP COLUMN IF EXISTS icon_color,
  DROP COLUMN IF EXISTS icon_name;
