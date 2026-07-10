-- ===========================================================================
-- Migration 106 — Schema evolution: per-materialization schema versions.
--
-- Each committed dataset_transaction already stores its own schema_definition
-- JSONB; this table tracks the version SEQUENCE per dataset + the build that
-- introduced each version, so materializeOutput can diff the new schema
-- against the latest version and classify the change (add-column = compatible;
-- drop/rename/type-change = breaking). A breaking change fails the build
-- loudly (Transform:BreakingSchemaChange); a compatible one is recorded + an
-- event is emitted.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dataset_schema_version (
  dataset_id            UUID   NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,
  version               INT    NOT NULL,
  column_names          JSONB  NOT NULL,
  inferred_types        JSONB  NOT NULL,
  schema_hash           TEXT   NOT NULL,
  introduced_by_build_rid TEXT,
  breaking              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dataset_schema_version_pk PRIMARY KEY (dataset_id, version)
);

CREATE INDEX IF NOT EXISTS dataset_schema_version_hash_idx
  ON dataset_schema_version (dataset_id, schema_hash);
