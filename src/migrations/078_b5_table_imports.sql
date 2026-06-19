-- B5 — table_imports + table_import_watermarks (spec §B5 lines 261-262).

CREATE TABLE IF NOT EXISTS table_imports (
  rid                text PRIMARY KEY
                       CHECK (rid LIKE 'ri.magritte.main.table-import.%'),
  connection_rid     text NOT NULL
                       REFERENCES connectivity_connections(rid) ON DELETE RESTRICT
                       CHECK (connection_rid LIKE 'ri.magritte.main.source.%'),
  dataset_rid        text NOT NULL
                       CHECK (dataset_rid LIKE 'ri.foundry.main.dataset.%'),
  display_name       text NOT NULL,
  config             jsonb NOT NULL,
  version            int NOT NULL DEFAULT 1,
  status             jsonb NOT NULL DEFAULT '{"state":"draft"}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL,
  deleted_at         timestamptz
);

CREATE INDEX IF NOT EXISTS table_imports_connection_idx
  ON table_imports(connection_rid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS table_imports_dataset_idx
  ON table_imports(dataset_rid)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS table_import_watermarks (
  import_rid         text PRIMARY KEY
                       REFERENCES table_imports(rid) ON DELETE CASCADE,
  watermark_column   text NOT NULL,
  watermark_value    text,
  observed_max       text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_build_rid     text
);
