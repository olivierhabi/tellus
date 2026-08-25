-- ---------------------------------------------------------------------------
-- FUNN-ISO-2 — Deployment environment identity + funnel_run/funnel_state
-- isolation columns.
--
-- Root cause of the 2026-07-31 split-brain: two stacks (dev + automate-
-- verify) polled the same Temporal namespace + task queue, so Temporal
-- dispatched activities of ONE logical workflow to workers connected to
-- DIFFERENT PostgreSQL databases, and projections that couldn't resolve
-- the object type treated that as a silent successful no-op.
--
-- This migration:
--   1. `deployment_environment` — singleton table persisting the immutable
--      environment identity of THIS database. Sealed on first boot by the
--      worker/migrate process (see environmentGuard.sealDatabaseEnvironment);
--      a mismatch with the process's configured TELLUS_ENVIRONMENT_ID
--      refuses worker startup. Database NAME alone is not authoritative —
--      copied dumps, restored backups, and port-forward accidents all
--      produce databases with the "right" name but the wrong contents.
--   2. `funnel_run.environment_id` / `temporal_run_id` — every funnel run
--      records which environment + Temporal run executed it so cross-env
--      writes are detectable in-band (constraint, not convention).
--   3. `funnel_state.environment_id` / `active_run_id` /
--      `active_run_started_at` — enables the compare-and-swap terminal
--      projection: a stale run can never overwrite a newer run's terminal
--      state, and a run stamped with another environment is rejected.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deployment_environment (
    -- Enforced singleton: every row carries singleton=TRUE and TRUE is the
    -- entire primary key, so a second environment can never be inserted.
    singleton       BOOLEAN      PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    environment_id  TEXT         NOT NULL CHECK (char_length(environment_id) BETWEEN 1 AND 128),
    database_name   TEXT         NOT NULL DEFAULT current_database(),
    sealed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sealed_by       TEXT         NOT NULL DEFAULT 'migrate'
);

COMMENT ON TABLE deployment_environment IS
    'Immutable deployment identity seal for THIS database (FUNN-ISO). Workers refuse to start when TELLUS_ENVIRONMENT_ID disagrees with the seal. Do not UPDATE; tear down and re-provision to re-seal.';

-- Funnel run provenance.
ALTER TABLE funnel_run
    ADD COLUMN IF NOT EXISTS environment_id TEXT,
    ADD COLUMN IF NOT EXISTS temporal_run_id TEXT;

COMMENT ON COLUMN funnel_run.environment_id IS
    'TELLUS_ENVIRONMENT_ID of the worker that owned this run. NULL rows predate FUNN-ISO.';
COMMENT ON COLUMN funnel_run.temporal_run_id IS
    'Temporal runId (distinct per workflow execution attempt) for cross-linking PG audit rows to Temporal history.';

CREATE INDEX IF NOT EXISTS idx_funnel_run_environment
    ON funnel_run (environment_id);

-- Funnel state CAS columns.
ALTER TABLE funnel_state
    ADD COLUMN IF NOT EXISTS environment_id TEXT,
    ADD COLUMN IF NOT EXISTS active_run_id UUID,
    ADD COLUMN IF NOT EXISTS active_run_started_at TIMESTAMPTZ;

COMMENT ON COLUMN funnel_state.active_run_id IS
    'funnel_run that produced the current terminal state; CAS guard against stale-run overwrite.';

-- Widen status vocabularies for the FUNN-ISO dispatch state machine:
--   funnel_run:    dispatch_pending → workflow_started → running →
--                  completed | failed | cancelled
--   funnel_state:  + 'cancelled' (object_type_deleted explicit terminal)
ALTER TABLE funnel_run DROP CONSTRAINT IF EXISTS funnel_run_status_check;
ALTER TABLE funnel_run ADD CONSTRAINT funnel_run_status_check
    CHECK (status IN (
        'dispatch_pending','workflow_started','running',
        'completed','failed','cancelled'
    ));

ALTER TABLE funnel_state DROP CONSTRAINT IF EXISTS funnel_state_status_check;
ALTER TABLE funnel_state ADD CONSTRAINT funnel_state_status_check
    CHECK (status IN (
        'not_indexed','indexing','indexed','failed','stale','cancelled'
    ));
