-- ---------------------------------------------------------------------------
-- Task B2 — Iceberg metadata-emission retry tracking.
--
-- The S3 metadata.json emitter is fire-and-forget so it doesn't block
-- snapshot commits. In prod, S3 503s or network blips can silently drop
-- emissions. We track completion per-snapshot so a sweeper can retry.
-- ---------------------------------------------------------------------------

ALTER TABLE funnel_snapshot
    ADD COLUMN IF NOT EXISTS metadata_emitted_at TIMESTAMPTZ;

ALTER TABLE funnel_snapshot
    ADD COLUMN IF NOT EXISTS metadata_emit_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE funnel_snapshot
    ADD COLUMN IF NOT EXISTS metadata_last_error TEXT;

-- Sweeper hotspot: snapshots without a successful emission, ordered so
-- the oldest un-emitted ones go first.
CREATE INDEX IF NOT EXISTS idx_funnel_snapshot_metadata_pending
    ON funnel_snapshot (committed_at)
    WHERE metadata_emitted_at IS NULL;
