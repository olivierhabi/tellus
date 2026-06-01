-- B9 — Funnel binding registry + checkpointing.

CREATE TABLE IF NOT EXISTS funnel_bindings (
  rid                  text PRIMARY KEY
                         CHECK (rid LIKE 'ri.funnel.main.binding.%'),
  dataset_rid          text NOT NULL,
  object_type_rid      text NOT NULL,
  property_map         jsonb NOT NULL,
  indexed_properties   jsonb NOT NULL,
  pk_column            text NOT NULL,
  title_property       text,
  shard_count          int NOT NULL DEFAULT 16,
  mode                 text NOT NULL CHECK (mode IN ('batch','streaming')),
  cdc_topic_short      text,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','indexing','ready','failed','reindexing')),
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE INDEX IF NOT EXISTS funnel_bindings_otype_idx
  ON funnel_bindings(object_type_rid)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS funnel_checkpoints (
  binding_rid          text NOT NULL,
  topic                text NOT NULL,
  partition            int NOT NULL,
  committed_offset     bigint NOT NULL,
  last_write_ts        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (binding_rid, topic, partition)
);
