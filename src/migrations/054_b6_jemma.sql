-- ----------------------------------------------------------------------------
-- 054 — B6 Jemma run lifecycle DDL.
--
-- Owns:
--   * jemma_run         — one row per run (lifecycle)
--   * jemma_run_stage   — one row per (run, stage)
--
-- Spec §B6 reference DDL was extended for:
--   * trigger_kind enum CHECK
--   * state enum CHECK (QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELLED|TIMED_OUT)
--   * stage state CHECK (PENDING|RUNNING|SUCCEEDED|FAILED|SKIPPED)
--   * partial unique index for "at most one ACTIVE run per (repo,ref)"
--   * resource_version for ETag on the run row
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jemma_run (
  rid               TEXT PRIMARY KEY,
  repository_rid    TEXT NOT NULL,
  ref               TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  trigger_kind      TEXT NOT NULL,
  triggered_by      UUID NOT NULL,
  state             TEXT NOT NULL,
  pod_name          TEXT,
  queued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  exit_code         INTEGER,
  failure_reason    TEXT,
  resource_version  INTEGER NOT NULL DEFAULT 1,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jemma_run_state_chk
    CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')),
  CONSTRAINT jemma_run_trigger_chk
    CHECK (trigger_kind IN ('PUSH','PR','TAG','MANUAL')),
  CONSTRAINT jemma_run_resource_version_chk
    CHECK (resource_version >= 1),
  CONSTRAINT jemma_run_commit_sha_chk
    CHECK (commit_sha ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT jemma_run_lifecycle_chk
    CHECK (
      (state = 'QUEUED' AND started_at IS NULL AND finished_at IS NULL)
      OR (state = 'RUNNING' AND started_at IS NOT NULL AND finished_at IS NULL)
      OR (state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT') AND finished_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS jemma_run_repo_ref_idx
  ON jemma_run(repository_rid, ref, queued_at DESC);

-- "At most one ACTIVE run per (repo, ref)" — concurrency invariant per spec
-- §B6: a new push while a run is in-flight cancels the in-flight run before
-- starting the new one.
CREATE UNIQUE INDEX IF NOT EXISTS jemma_run_active_per_ref_uq
  ON jemma_run(repository_rid, ref)
  WHERE state IN ('QUEUED','RUNNING');

CREATE INDEX IF NOT EXISTS jemma_run_state_idx
  ON jemma_run(state)
  WHERE state IN ('QUEUED','RUNNING');

CREATE TABLE IF NOT EXISTS jemma_run_stage (
  run_rid           TEXT NOT NULL REFERENCES jemma_run(rid) ON DELETE CASCADE,
  stage_name        TEXT NOT NULL,
  state             TEXT NOT NULL,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  log_object_uri    TEXT,
  exit_code         INTEGER,
  PRIMARY KEY (run_rid, stage_name),
  CONSTRAINT jemma_run_stage_state_chk
    CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  CONSTRAINT jemma_run_stage_name_chk
    CHECK (stage_name IN ('setup','lint','test','build','publish'))
);

CREATE INDEX IF NOT EXISTS jemma_run_stage_run_idx
  ON jemma_run_stage(run_rid);
