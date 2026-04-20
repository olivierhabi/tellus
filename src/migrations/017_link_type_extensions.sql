-- ---------------------------------------------------------------------------
-- Link Type Extensions (LT-B1..B10)
--
-- Additive schema changes supporting the full suite of Link Type
-- improvements. Every ALTER uses IF NOT EXISTS so re-running is safe.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- LT-B1 / LT-B7 — storage backend flag + MCP wiring on link_type
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_storage_backend') THEN
    CREATE TYPE link_storage_backend AS ENUM ('csv_legacy', 'iceberg');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_violation_policy') THEN
    CREATE TYPE link_violation_policy AS ENUM ('warn', 'reject', 'quarantine');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_mcp_propagation_mode') THEN
    CREATE TYPE link_mcp_propagation_mode AS ENUM ('source', 'target', 'union', 'intersection');
  END IF;
END $$;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS storage_backend link_storage_backend NOT NULL DEFAULT 'csv_legacy';

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS iceberg_table_name TEXT;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS migration_started_at TIMESTAMPTZ;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS migration_completed_at TIMESTAMPTZ;

-- LT-B4: ONE_TO_ONE violation policy
ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS violation_policy link_violation_policy NOT NULL DEFAULT 'warn';

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS violation_count_24h INTEGER NOT NULL DEFAULT 0;

-- LT-B6: Bidirectional reverse spec
ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_api_name TEXT;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_display_name TEXT;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_description TEXT;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_visible BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_property_projection JSONB;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS reverse_actions_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS bidirectional_migrated_at TIMESTAMPTZ;

-- LT-B7: Mandatory Control Properties
ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS mandatory_control_property_id UUID;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS mcp_propagation_mode link_mcp_propagation_mode NOT NULL DEFAULT 'union';

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS mcp_required_count INTEGER NOT NULL DEFAULT 1;

-- Seed reverse_api_name for existing bidirectional rows
UPDATE link_type
   SET reverse_api_name = api_name || '_reverse',
       reverse_display_name = display_name || ' (reverse)',
       bidirectional_migrated_at = now()
 WHERE is_bidirectional = true
   AND reverse_api_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_link_type_storage_backend
    ON link_type (storage_backend);

CREATE INDEX IF NOT EXISTS idx_link_type_reverse_api_name
    ON link_type (ontology_id, reverse_api_name)
    WHERE reverse_api_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- LT-B3 — link_edit coordination columns (mirrors object_edits B1 pattern)
-- ---------------------------------------------------------------------------

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS applied_to_iceberg_at TIMESTAMPTZ;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS applied_to_index_at TIMESTAMPTZ;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS actor_principal_id TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS action_rid TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS correlation_id TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS causation_id TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS retracts_event_id TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS event_id TEXT;

ALTER TABLE link_edit
    ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '2.0.0';

-- Allow operation = 'retract' alongside add/remove
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_edit_operation_check') THEN
    ALTER TABLE link_edit DROP CONSTRAINT link_edit_operation_check;
  END IF;
END $$;

ALTER TABLE link_edit
    ADD CONSTRAINT link_edit_operation_check
        CHECK (operation IN ('add', 'remove', 'retract'));

CREATE INDEX IF NOT EXISTS idx_link_edit_pending_iceberg
    ON link_edit (link_type_api_name, executed_at)
    WHERE applied_to_iceberg_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_link_edit_pending_index
    ON link_edit (link_type_api_name, executed_at)
    WHERE applied_to_index_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_link_edit_correlation_id
    ON link_edit (correlation_id)
    WHERE correlation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- LT-B2 — link_resolver_config (per ontology)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_escalation_backend') THEN
    CREATE TYPE link_escalation_backend AS ENUM ('none', 'clickhouse', 'furnace');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS link_resolver_config (
    ontology_id                UUID         PRIMARY KEY,
    max_intermediate_pks       INTEGER      NOT NULL DEFAULT 100000
                                  CHECK (max_intermediate_pks BETWEEN 1 AND 1000000),
    max_search_around_source   INTEGER      NOT NULL DEFAULT 100000
                                  CHECK (max_search_around_source BETWEEN 1 AND 1000000),
    max_multihop_intermediate  INTEGER      NOT NULL DEFAULT 100000
                                  CHECK (max_multihop_intermediate BETWEEN 1 AND 1000000),
    escalation_backend         link_escalation_backend NOT NULL DEFAULT 'clickhouse',
    escalation_threshold_pks   INTEGER      NOT NULL DEFAULT 100000
                                  CHECK (escalation_threshold_pks BETWEEN 100 AND 1000000),
    global_hard_cap            INTEGER      NOT NULL DEFAULT 1000000
                                  CHECK (global_hard_cap BETWEEN 1000 AND 1000000),
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- LT-B4 — link_quarantine (ONE_TO_ONE violation bucket)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_quarantine_status') THEN
    CREATE TYPE link_quarantine_status AS ENUM ('pending', 'resolved', 'dismissed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS link_quarantine (
    violation_id    UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    link_type_id    UUID                     NOT NULL,
    ontology_id     UUID                     NOT NULL,
    link_type_api_name TEXT                  NOT NULL,
    source_pk       TEXT                     NOT NULL,
    target_pk       TEXT                     NOT NULL,
    attempted_at    TIMESTAMPTZ              NOT NULL DEFAULT now(),
    reason          JSONB                    NOT NULL DEFAULT '{}'::jsonb,
    status          link_quarantine_status   NOT NULL DEFAULT 'pending',
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_quarantine_link_type
    ON link_quarantine (link_type_id, status);

CREATE INDEX IF NOT EXISTS idx_link_quarantine_pending
    ON link_quarantine (ontology_id, attempted_at DESC)
    WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- LT-B5 — link_orphan_stats (Wilson-interval sampling job output)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_orphan_stats (
    id                      BIGSERIAL     PRIMARY KEY,
    link_type_id            UUID          NOT NULL,
    link_type_api_name      TEXT          NOT NULL,
    ontology_id             UUID          NOT NULL,
    scanned_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    sample_size             INTEGER       NOT NULL,
    orphan_count            INTEGER       NOT NULL,
    pending_count           INTEGER       NOT NULL DEFAULT 0,
    resolved_count          INTEGER       NOT NULL DEFAULT 0,
    orphan_rate             DOUBLE PRECISION NOT NULL,
    p_orphan_window_lower   DOUBLE PRECISION NOT NULL,
    p_orphan_window_upper   DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_orphan_stats_link_type
    ON link_orphan_stats (link_type_id, scanned_at DESC);

-- ---------------------------------------------------------------------------
-- LT-B8 — object_cdc_outbox (transactional outbox for object edits)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS object_cdc_outbox (
    event_id       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    topic          TEXT          NOT NULL,
    payload        JSONB         NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ,
    publish_attempts INTEGER      NOT NULL DEFAULT 0,
    last_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_object_cdc_outbox_pending
    ON object_cdc_outbox (created_at)
    WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- LT-B9 — pagination sessions (shared Redis namespace managed in code; this
-- is a fallback Postgres store for environments without Redis)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS link_pagination_session (
    pit_id        TEXT          PRIMARY KEY,
    ontology_id   UUID          NOT NULL,
    link_type_id  UUID,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ   NOT NULL,
    backend       TEXT          NOT NULL,
    state         JSONB         NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_link_pagination_session_expiry
    ON link_pagination_session (expires_at);
