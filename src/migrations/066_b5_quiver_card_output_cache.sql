-- Quiver B5 — quiver_card_output_cache
-- Per spec: cache key = SHA256(cardId || configHash || sortedUpstreamHashes || branch || ontologyVersionForBranch)
-- 1h base TTL; refreshed on hit; small results inline (≤64 KB), large results via blob URI.

CREATE TABLE IF NOT EXISTS quiver_card_output_cache (
  cache_key            TEXT PRIMARY KEY,
  analysis_rid         TEXT NOT NULL,
  card_id              TEXT NOT NULL,
  card_type            TEXT NOT NULL,
  branch_rid           TEXT NOT NULL DEFAULT 'master',
  ontology_version     TEXT NOT NULL,
  result_type          TEXT NOT NULL,
  result_inline        BYTEA,
  result_blob_uri      TEXT,
  result_size_bytes    INTEGER NOT NULL DEFAULT 0,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  hit_count            BIGINT NOT NULL DEFAULT 0,
  CHECK (result_inline IS NOT NULL OR result_blob_uri IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_quiver_cache_analysis_branch
  ON quiver_card_output_cache (analysis_rid, branch_rid);

CREATE INDEX IF NOT EXISTS idx_quiver_cache_expires_at
  ON quiver_card_output_cache (expires_at);

CREATE INDEX IF NOT EXISTS idx_quiver_cache_ontology_version
  ON quiver_card_output_cache (analysis_rid, branch_rid, ontology_version);
