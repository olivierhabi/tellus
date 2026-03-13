-- 007_create_interfaces.sql
-- Creates the Interface and Interface Property tables for the Ontology system.
-- Interfaces define shared property contracts that Object Types can implement,
-- enabling polymorphic queries across heterogeneous Object Types.

-- ---------------------------------------------------------------------------
-- interface: Stores Interface definitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interface (
  interface_id    UUID        PRIMARY KEY,
  ontology_id     UUID        NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name        TEXT        NOT NULL UNIQUE
                              CHECK (api_name ~ '^[A-Z][a-zA-Z0-9]*$'),
  display_name    TEXT        NOT NULL,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient lookup of all Interfaces in an Ontology
CREATE INDEX IF NOT EXISTS idx_interface_ontology_id ON interface(ontology_id);

-- ---------------------------------------------------------------------------
-- interface_property: Declares the properties an Interface defines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interface_property (
  interface_property_id UUID    PRIMARY KEY,
  interface_id          UUID    NOT NULL REFERENCES interface(interface_id) ON DELETE CASCADE,
  api_name              TEXT    NOT NULL
                                CHECK (api_name ~ '^[a-z][a-zA-Z0-9]*$'),
  display_name          TEXT    NOT NULL,
  base_type             TEXT    NOT NULL
                                CHECK (base_type IN (
                                  'string', 'boolean', 'integer', 'long', 'double', 'float',
                                  'date', 'timestamp', 'byte', 'short', 'decimal',
                                  'geopoint', 'geoshape',
                                  'string_array', 'integer_array', 'long_array',
                                  'double_array', 'boolean_array', 'timestamp_array',
                                  'struct'
                                )),
  is_required           BOOLEAN NOT NULL DEFAULT false,
  ordinal               INTEGER NOT NULL DEFAULT 0,
  UNIQUE (interface_id, api_name)
);

-- Index for efficient lookup of all properties in an Interface
CREATE INDEX IF NOT EXISTS idx_interface_property_interface_id ON interface_property(interface_id);
