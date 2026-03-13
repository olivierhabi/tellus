-- 008_create_object_type_interface.sql
-- Creates the bridge table that records which Object Types implement which
-- Interfaces, along with the property mapping that connects Interface
-- properties to Object Type properties.

CREATE TABLE IF NOT EXISTS object_type_interface (
  object_type_id   UUID        NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
  interface_id     UUID        NOT NULL REFERENCES interface(interface_id) ON DELETE RESTRICT,
  property_mapping JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type_id, interface_id)
);

-- Index for efficient lookup of all Object Types implementing a given Interface
-- (used by polymorphic queries in Task 8)
CREATE INDEX IF NOT EXISTS idx_oti_interface_id ON object_type_interface(interface_id);
