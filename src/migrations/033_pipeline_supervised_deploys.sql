-- ---------------------------------------------------------------------------
-- Task PB-B1 — Supervised, idempotent, cancellable pipeline deploys.
--
-- Replaces the fire-and-forget `startDeployment → executeBuild(…).catch()`
-- path in src/services/deploymentService.ts with a durable supervisor
-- modelled on the Funnel's `funnel_signal` + `funnelDispatcher.ts` loop
-- (FOR UPDATE SKIP LOCKED on a 2s tick; Temporal-optional).
--
-- Columns on pipeline_deployments:
--   * idempotency_key        — client-supplied fingerprint; unique when
--                              non-null so legacy rows aren't squeezed.
--   * cancellation_requested_at — cooperative cancellation signal. The
--                              worker polls this between activities and
--                              exits cleanly, marking status='cancelled'.
--   * max_run_duration_seconds — orphan-sweeper threshold. Any deploy in
--                              status='running' older than this is swept
--                              to status='failed' with supervisor_timeout.
--
-- pipeline_signal mirrors funnel_signal shape. We do NOT share the funnel
-- table because the subject primary key differs (pipeline_id vs
-- object_type_api_name) and coupling the two inboxes into one table would
-- make the dispatcher's SKIP LOCKED claim race across subsystems.
-- ---------------------------------------------------------------------------

-- 1. Idempotency + cancellation columns ------------------------------------

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;

ALTER TABLE pipeline_deployments
    ADD COLUMN IF NOT EXISTS max_run_duration_seconds INTEGER NOT NULL DEFAULT 14400;

-- Partial unique index: existing rows (NULL idempotency_key) never fight
-- for the same slot. New rows ride ON CONFLICT (idempotency_key) DO NOTHING
-- to make POST /deploy safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_deployments_idempotency_unique
    ON pipeline_deployments (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Sweeper hotspot: running rows ordered by started_at so the oldest orphan
-- is reconciled first.
CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_running
    ON pipeline_deployments (started_at)
    WHERE status = 'running';

-- 2. pipeline_signal inbox -------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_signal (
    signal_id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pipeline_id               UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    project_id                UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    deployment_id             UUID        REFERENCES pipeline_deployments(id) ON DELETE CASCADE,
    signal_type               TEXT        NOT NULL
                               CHECK (signal_type IN ('deployStart','cancelDeployment')),
    payload                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
    signal_fingerprint        TEXT,
    received_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at               TIMESTAMPTZ,
    consumed_by_deployment_id UUID        REFERENCES pipeline_deployments(id) ON DELETE SET NULL,
    redelivery_count          INTEGER     NOT NULL DEFAULT 0
);

-- Pending inbox: dispatcher scans this index with SKIP LOCKED.
CREATE INDEX IF NOT EXISTS idx_pipeline_signal_pending
    ON pipeline_signal (pipeline_id, received_at ASC)
    WHERE consumed_at IS NULL;

-- Dedup: two POST /deploy calls with the same Idempotency-Key within the
-- dedup window both insert a signal row, but only the first takes the
-- fingerprint slot — mirrors funnel_signal.signal_fingerprint_unique.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_signal_fingerprint_unique
    ON pipeline_signal (pipeline_id, signal_fingerprint)
    WHERE signal_fingerprint IS NOT NULL;
