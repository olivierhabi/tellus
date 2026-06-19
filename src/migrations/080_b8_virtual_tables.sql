-- B8 — virtual_tables (spec §B8 line 410).

CREATE TABLE IF NOT EXISTS virtual_tables (
  rid                text PRIMARY KEY
                       CHECK (rid LIKE 'ri.magritte.main.virtual-table.%'),
  connection_rid     text NOT NULL
                       REFERENCES connectivity_connections(rid) ON DELETE RESTRICT
                       CHECK (connection_rid LIKE 'ri.magritte.main.source.%'),
  dataset_rid        text NOT NULL
                       CHECK (dataset_rid LIKE 'ri.foundry.main.dataset.%'),
  display_name       text NOT NULL,
  source_schema      text NOT NULL,
  source_table       text NOT NULL,
  schema_json        jsonb NOT NULL DEFAULT '[]'::jsonb,
  schema_stale       boolean NOT NULL DEFAULT true,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL,
  deleted_at         timestamptz
);

CREATE INDEX IF NOT EXISTS virtual_tables_connection_idx
  ON virtual_tables(connection_rid)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS virtual_tables_dataset_idx
  ON virtual_tables(dataset_rid)
  WHERE deleted_at IS NULL;
