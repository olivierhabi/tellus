-- ---------------------------------------------------------------------------
-- 153 — Transactional outbox for link CDC events (OSv2 serving-index parity).
--
-- Replaces the fire-and-forget `void publishLinkCdc(...)` that ran AFTER the
-- edit transaction committed in editApplicator.ts. With this table the
-- domain mutation (link_edit insert in applyEdits) and its outbox record
-- commit atomically in the same PostgreSQL transaction; a drainer loop
-- then publishes to Kafka with bounded exponential backoff + jitter and
-- dead-letters after max attempts. Restart-safe, idempotent (stable
-- event_id), concurrency-safe (FOR UPDATE SKIP LOCKED), duplicate-safe
-- (ClickHouse ReplacingMergeTree dedups on (identity, event_version)).
--
-- IMPORTANT: `published_at` means "handed to the broker", NOT "visible in
-- the serving edge index". Serving-index acknowledgement is tracked
-- separately (edit applied_to_index_at / CDC watermark endpoints); never
-- acknowledge an Action as indexed from this table alone.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_cdc_outbox (
    event_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    topic               TEXT        NOT NULL,
    tenant_id           TEXT,
    ontology_id         TEXT,
    branch_id           TEXT,
    link_type_api_name  TEXT        NOT NULL,
    source_object_type  TEXT        NOT NULL,
    source_primary_key  TEXT        NOT NULL,
    target_primary_key  TEXT        NOT NULL,
    operation           TEXT        NOT NULL CHECK (operation IN ('ADD', 'REMOVE', 'RETRACT')),
    schema_version      TEXT        NOT NULL DEFAULT '2.0.0',
    payload             JSONB       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    publish_attempts    INTEGER     NOT NULL DEFAULT 0,
    last_error          TEXT,
    published_at        TIMESTAMPTZ,
    dead_lettered_at    TIMESTAMPTZ
);

-- Hot path: drainer claims overdue, unpublished, non-dead-lettered rows.
CREATE INDEX IF NOT EXISTS idx_link_cdc_outbox_pending
    ON link_cdc_outbox (next_attempt_at)
    WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Ops visibility: dead letters and per-link-type backlog.
CREATE INDEX IF NOT EXISTS idx_link_cdc_outbox_dead
    ON link_cdc_outbox (dead_lettered_at)
    WHERE dead_lettered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_link_cdc_outbox_link_type
    ON link_cdc_outbox (link_type_api_name, created_at);
