-- Durable reverse lookup for deterministic RIDs of datasource-only objects.
--
-- object_instances remains the canonical materialized/writeback store. This
-- compact locator table covers objects that exist only in Object Storage and
-- therefore cannot be inserted into object_instances without inventing an
-- incomplete properties document.

CREATE TABLE IF NOT EXISTS object_rid_lookup (
  rid                   TEXT PRIMARY KEY,
  ontology_id           UUID NOT NULL REFERENCES ontology(ontology_id)
                              ON DELETE CASCADE,
  object_type_api_name  TEXT NOT NULL,
  primary_key           TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ontology_id, object_type_api_name, primary_key)
);

CREATE INDEX IF NOT EXISTS idx_object_rid_lookup_object
  ON object_rid_lookup (ontology_id, object_type_api_name, primary_key);
