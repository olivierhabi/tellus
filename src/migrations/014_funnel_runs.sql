-- ---------------------------------------------------------------------------
-- Task B3 — Durable Funnel workflow journal.
--
-- Mirrors the inline definitions in src/migrate.ts so a fresh
-- src/migrations/ run brings up `funnel_run`, `funnel_stage_run`,
-- `funnel_signal`, `funnel_changelog_watermark` without needing to
-- invoke the legacy programmatic migrator.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funnel_run (
    run_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology_id           UUID        NOT NULL,
    object_type_api_name  TEXT        NOT NULL,
    workflow_type         TEXT        NOT NULL DEFAULT 'ObjectTypeFunnelWorkflow',
    status                TEXT        NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','completed','failed','cancelled')),
    current_stage         TEXT,
    objects_indexed       BIGINT      NOT NULL DEFAULT 0,
    error_message         TEXT,
    signal_payload        JSONB,
    parent_run_id         UUID        REFERENCES funnel_run(run_id) ON DELETE SET NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_funnel_run_ot_started
    ON funnel_run(object_type_api_name, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_funnel_run_active
    ON funnel_run(object_type_api_name)
    WHERE status = 'running';

-- Alias view matching the spec-named `funnel_runs` so external tooling
-- that reads the spec literally resolves. Kept as a view so writes go
-- through the canonical `funnel_run` table.
CREATE OR REPLACE VIEW funnel_runs AS
    SELECT * FROM funnel_run;

CREATE TABLE IF NOT EXISTS funnel_stage_run (
    stage_run_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID        NOT NULL REFERENCES funnel_run(run_id) ON DELETE CASCADE,
    stage                 TEXT        NOT NULL
                           CHECK (stage IN ('changelog','merge','indexing','hydration')),
    status                TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','running','succeeded','failed','timed_out')),
    attempt               INTEGER     NOT NULL DEFAULT 1,
    input_json            JSONB,
    output_json           JSONB,
    error_message         TEXT,
    timeout_seconds       INTEGER     NOT NULL DEFAULT 3600,
    started_at            TIMESTAMPTZ,
    finished_at           TIMESTAMPTZ,
    UNIQUE (run_id, stage, attempt)
);

CREATE INDEX IF NOT EXISTS idx_funnel_stage_run_status
    ON funnel_stage_run(status, started_at);

CREATE TABLE IF NOT EXISTS funnel_signal (
    signal_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ontology_id           UUID        NOT NULL,
    object_type_api_name  TEXT        NOT NULL,
    signal_type           TEXT        NOT NULL
                           CHECK (signal_type IN ('sourceTransactionCommitted',
                                                  'editBatchPending',
                                                  'schemaChanged')),
    payload               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at           TIMESTAMPTZ,
    consumed_by_run_id    UUID        REFERENCES funnel_run(run_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_funnel_signal_pending
    ON funnel_signal(object_type_api_name, received_at ASC)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS funnel_changelog_watermark (
    ontology_id           UUID        NOT NULL,
    object_type_api_name  TEXT        NOT NULL,
    source_datasource_id  UUID        NOT NULL,
    last_from_snapshot_id UUID,
    last_to_snapshot_id   UUID,
    last_run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_rows_emitted     BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (ontology_id, object_type_api_name, source_datasource_id)
);
