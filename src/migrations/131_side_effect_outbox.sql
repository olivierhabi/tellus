-- ---------------------------------------------------------------------------
-- Migration 131 — Action Side-Effect Outbox (durable transactional outbox)
--
-- Production side effects MUST NOT be dispatched as fire-and-forget
-- promises in the API process. After the ontology edit transaction
-- commits, the same database transaction inserts one row per side
-- effect into this outbox. A stateless worker (Phase 5) later claims
-- jobs safely, dispatches them with bounded exponential backoff + jitter,
-- moves exhausted jobs to dead-letter, and emits metrics + structured
-- logs.
--
-- A side-effect failure NEVER rolls back committed ontology edits —
-- the ontology commits first, then outbox rows are written in the same
-- transaction. The worker is the durable delivery boundary.
--
-- Phase 1 lands ONLY storage. Phase 5 wires up the worker, the
-- NotificationProvider abstraction, retry/dead-letter transitions, and
-- the request-path writer that replaces the in-process fire-and-forget
-- `actionWebhooks.ts` path. This table is read-only until Phase 5.
--
-- Concurrency-safety: the worker claims rows atomically with
-- `SELECT ... FOR UPDATE SKIP LOCKED` + an `attemptCount`/`nextAttemptAt`
-- machine. The `status` CHECK + partial indexes make the claim query
-- cheap and safe under multiple worker replicas.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_side_effect_job (
  job_id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Correlation keys back to the execution that created this job. The
  -- action_audit_log table is the source of truth for the full execution
  -- history; these columns let the worker enrich structured logs without
  -- a join in the hot path.
  execution_id        UUID         NOT NULL,
  action_type_id      UUID         NOT NULL,
  action_type_version INTEGER      NOT NULL,
  side_effect_index   INTEGER      NOT NULL CHECK (side_effect_index >= 0),

  -- Discriminator: webhook (HTTP fanout via webhook_definition) or
  -- notification (in-app / email / slack-compatible via NotificationProvider).
  kind                TEXT         NOT NULL CHECK (kind IN ('webhook', 'notification')),

  -- The configured payload. For webhooks: { webhookId, webhookVersion,
  -- inputs }. For notifications: { channel, recipients[], templateId,
  -- templateParameters }. The worker validates the shape before dispatch.
  payload             JSONB        NOT NULL,

  -- State machine.
  status              TEXT         NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'succeeded',
                                        'retrying', 'failed', 'dead')),

  attempt_count       INTEGER      NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code     TEXT,
  last_error_at       TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ,

  -- Idempotency metadata. The worker sends an idempotency key derived
  -- from (job_id, attempt_count) on every retry to make at-least-once
  -- delivery safe against webhook duplicates.
  idempotency_key     TEXT,

  -- Reconciliation state for the unhappy path: external write succeeded
  -- but the local commit failed. The worker records the external
  -- delivery receipt here so operators can reconcile.
  external_receipt   JSONB,

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Unique job identity: a single execution cannot enqueue two jobs with
  -- the same (execution_id, side_effect_index). The partial unique index
  -- lets in-place worker updates NOT collide when the job transitions.
  UNIQUE (execution_id, side_effect_index)
);

-- Worker claim queue: jobs ready to run, oldest first, FOR UPDATE SKIP
-- LOCKED. The CHECK + partial index predicates keep the index small and
-- the claim query O(log n).
CREATE INDEX IF NOT EXISTS idx_action_side_effect_job_claim
  ON action_side_effect_job(next_attempt_at, created_at)
  WHERE status IN ('pending', 'retrying');

-- Per-execution lookup for "are all side effects done for this execution?".
CREATE INDEX IF NOT EXISTS idx_action_side_effect_job_execution
  ON action_side_effect_job(execution_id, status);

-- Per-action-type + per-status summary metrics (worker dashboard uses
-- this to compute queue depth, retry rate, dead-letter rate per action).
CREATE INDEX IF NOT EXISTS idx_action_side_effect_job_action_status
  ON action_side_effect_job(action_type_id, status, created_at);

-- Dead-letter operator view: every job in 'dead' state ordered by age.
CREATE INDEX IF NOT EXISTS idx_action_side_effect_job_dead
  ON action_side_effect_job(created_at)
  WHERE status = 'dead';

COMMENT ON TABLE action_side_effect_job IS
  'Durable, transactional outbox for action side effects (webhook fanout + notifications). Rows are inserted in the SAME database transaction as the ontology edit commit, never after — so a side effect failure NEVER rolls back committed edits. A stateless worker (Phase 5) claims via SELECT ... FOR UPDATE SKIP LOCKED with bounded exponential backoff + jitter, enforces retry limits, and moves exhausted jobs to dead-letter. Idempotency keys make at-least-once delivery safe against duplicates.';
COMMENT ON COLUMN action_side_effect_job.execution_id IS
  'Correlation back to the action_audit_log row that owns this side effect. The audit log is the source of truth for full execution history.';
COMMENT ON COLUMN action_side_effect_job.side_effect_index IS
  'Stable ordinal within the execution. (execution_id, side_effect_index) is unique — even across retries only one job row exists per (execution, side effect). The worker never needs to coalesce.';
COMMENT ON COLUMN action_side_effect_job.next_attempt_at IS
  'When the worker may next claim this job. NULL when status NOT IN (''pending'',''retrying''). The claim query is `WHERE next_attempt_at <= now() AND status IN (''pending'',''retrying'') ORDER BY next_attempt_at, created_at FOR UPDATE SKIP LOCKED LIMIT N`.';
COMMENT ON COLUMN action_side_effect_job.idempotency_key IS
  'Stable key passed to the webhook on every attempt. Usually `sha256(job_id || ''.'' || attempt_count)` — distinct across attempts but stable per attempt, so an external system that received a previous delivery can deduplicate safely even if it returned a transient non-2xx.';
COMMENT ON COLUMN action_side_effect_job.external_receipt IS
  'Operator-visible recovery metadata for the external success / local commit failure window. Carries the external system''s delivery id when available, so reconciliation can be performed without re-issuing the side effect.';
