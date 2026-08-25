-- ---------------------------------------------------------------------------
-- 158 — ClickHouse table-migration state machine (OSv2 serving parity).
--
-- ONE row per attempt; drivers resume from the last persisted phase, so
-- interruption at ANY step is honest: idempotent replay, checksum-verified
-- cutover, deterministic rollback target preserved.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_table_migration (
  migration_id       uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_table       text        NOT NULL,
  snapshot_table     text        NOT NULL,
  source_engine      text        NOT NULL,
  target_engine      text        NOT NULL,
  phase              text        NOT NULL DEFAULT 'init',
  -- Offsets + boundary watermarks (CdcOffset from the Kafka snapshot;
  -- edge_revision from the version contract) recorded per phase transition.
  boundary_cdc_offset  bigint    NOT NULL DEFAULT 0,
  boundary_edge_version bigint   NOT NULL DEFAULT 0,
  catchup_start_cdc_offset bigint NOT NULL DEFAULT 0,
  catchup_end_cdc_offset   bigint NOT NULL DEFAULT 0,
  copied_rows        bigint      NOT NULL DEFAULT 0,
  rejected_rows      bigint      NOT NULL DEFAULT 0,
  source_row_count   bigint      NOT NULL DEFAULT 0,
  target_row_count   bigint      NOT NULL DEFAULT 0,
  source_checksum    text,
  target_checksum    text,
  traversal_match    boolean,
  final_confirmed_seq bigint    NOT NULL DEFAULT 0,
  rollback_table     text,                  -- the renamed-away source (kept until complete)
  error              text,                  -- present on phase=failed
  started_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);

COMMENT ON TABLE link_table_migration IS
  'Stage-6: per-attempt ClickHouse table migration state. Drivers: src/services/searchAround/linkTableMigration.ts. Completed rows keep the evidence (counts+checksums+watermarks) of a two-phase replay-verified swap.';
