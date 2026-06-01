-- B10 — Ontology bindings join Object Types to Funnel-indexed datasets.

CREATE TABLE IF NOT EXISTS ontology_bindings (
  rid                 text PRIMARY KEY
                        CHECK (rid LIKE 'ri.ontology.main.binding.%'),
  object_type_rid     text NOT NULL,
  dataset_rid         text NOT NULL,
  funnel_binding_rid  text NOT NULL,
  property_map        jsonb NOT NULL,
  pk_property         text NOT NULL,
  title_property      text,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','indexing','ready','failed')),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS ontology_bindings_otype_idx
  ON ontology_bindings(object_type_rid) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ontology_link_types_from_fk (
  rid                 text PRIMARY KEY
                        CHECK (rid LIKE 'ri.ontology.main.link.%'),
  source_object_type  text NOT NULL,
  target_object_type  text NOT NULL,
  source_property     text NOT NULL,
  target_property     text NOT NULL,
  cardinality         text NOT NULL CHECK (cardinality IN ('one-to-one','one-to-many','many-to-many')),
  join_dataset_rid    text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
