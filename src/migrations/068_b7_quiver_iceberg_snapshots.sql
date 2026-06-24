-- Quiver B7 — augments the B5 card-output cache with the Iceberg
-- snapshot pinning required for materialization invalidation tracking.
-- Per spec §B7 C-06: every materialization records the dataset → snapshot
-- mapping so we can re-execute when an upstream Iceberg commit invalidates
-- the cached result. Map is JSONB keyed by datasetRid.
ALTER TABLE quiver_card_output_cache
  ADD COLUMN IF NOT EXISTS iceberg_snapshots JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Per spec §B7 C-07: results > 1 MiB are externalised to Blobster; record
-- the resulting URI alongside the inline payload column added in 066.
ALTER TABLE quiver_card_output_cache
  ADD COLUMN IF NOT EXISTS result_blob_uri TEXT;

-- Tier label and chosen Calcite plan are recorded for observability +
-- the plan-equivalence golden test (B7 C-05). They are advisory; the
-- cache key (set in B5) remains the authoritative invalidation source.
ALTER TABLE quiver_card_output_cache
  ADD COLUMN IF NOT EXISTS mat_tier TEXT;

ALTER TABLE quiver_card_output_cache
  ADD COLUMN IF NOT EXISTS mat_plan_json JSONB;

-- Index over the iceberg_snapshots JSONB so the (future) snapshot-bump
-- invalidator can find affected cache rows efficiently.
CREATE INDEX IF NOT EXISTS quiver_card_output_cache_iceberg_gin
  ON quiver_card_output_cache USING GIN (iceberg_snapshots);
