-- ---------------------------------------------------------------------------
-- Task B9 — Replacement Pipeline state and diff-log tables
--
-- Postgres holds the source of truth for "which Quickwit index version is
-- LIVE for a given Object Type?". The Query API resolves via this table on
-- every request; cutover is a single UPDATE. The old index is kept for 48h
-- post-cutover for instant rollback.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'replacement_state') THEN
    CREATE TYPE replacement_state AS ENUM (
      'LIVE',                    -- steady state: single active index
      'REPLACEMENT_BACKFILL',    -- sibling index exists, backfill in progress
      'REPLACEMENT_SOAK',        -- backfill done, shadow-diff collection
      'CUTOVER_PENDING',         -- diff gate passed, flip approved
      'CUTOVER_COMPLETE',        -- alias pointed at sibling; old index retained
      'OLD_INDEX_DROPPED',       -- 48h grace elapsed, old index deleted
      'ROLLED_BACK'              -- cutover reversed within grace window
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- object_type_active_index_version — the authoritative alias table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS object_type_active_index_version (
    object_type_api_name  TEXT PRIMARY KEY,
    active_version        INTEGER           NOT NULL DEFAULT 1,
    pending_version       INTEGER,                     -- the sibling under backfill/soak
    state                 replacement_state NOT NULL DEFAULT 'LIVE',
    soak_days             INTEGER           NOT NULL DEFAULT 7
                          CHECK (soak_days BETWEEN 1 AND 14),
    diff_rate_threshold   DOUBLE PRECISION  NOT NULL DEFAULT 0.001,
    backfill_started_at   TIMESTAMPTZ,
    soak_started_at       TIMESTAMPTZ,
    last_cutover_at       TIMESTAMPTZ,
    last_rollback_at      TIMESTAMPTZ,
    old_index_retained_until TIMESTAMPTZ,             -- computed as cutover + 48h
    updated_at            TIMESTAMPTZ       NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otaiv_state
    ON object_type_active_index_version (state);

-- ---------------------------------------------------------------------------
-- replacement_diff_log — every shadow-query diff is recorded here so we can
-- compute rolling diff rate. The gate fires if `sum(diff_count)/sum(total) <
-- diff_rate_threshold` over the entire soak window.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS replacement_diff_log (
    id                    BIGSERIAL PRIMARY KEY,
    object_type_api_name  TEXT     NOT NULL,
    old_version           INTEGER  NOT NULL,
    new_version           INTEGER  NOT NULL,
    query_hash            TEXT     NOT NULL,
    query_body            JSONB,
    diff_count            INTEGER  NOT NULL DEFAULT 0,
    total_hits            INTEGER  NOT NULL DEFAULT 0,
    recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rdl_type_recorded
    ON replacement_diff_log (object_type_api_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_rdl_type_versions
    ON replacement_diff_log (object_type_api_name, old_version, new_version);
