-- Durable TypeScript Functions v2 publishing and per-function registry resources.

ALTER TABLE jemma_run
  ADD COLUMN IF NOT EXISTS job_name TEXT NOT NULL DEFAULT 'repository-checks';
ALTER TABLE jemma_run ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE jemma_run ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jemma_run_history_idx
  ON jemma_run(repository_rid, queued_at DESC, rid DESC);

CREATE TABLE IF NOT EXISTS function_publish_request (
  run_rid          TEXT PRIMARY KEY REFERENCES jemma_run(rid) ON DELETE CASCADE,
  repository_rid   TEXT NOT NULL,
  branch            TEXT NOT NULL,
  semver            TEXT NOT NULL,
  message           TEXT,
  default_branch    TEXT NOT NULL,
  version_rid       TEXT,
  artifact_sha256   TEXT,
  function_rids     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT function_publish_request_semver_chk
    CHECK (semver ~ '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$')
);

CREATE UNIQUE INDEX IF NOT EXISTS function_publish_request_release_uq
  ON function_publish_request(repository_rid, branch, semver);

CREATE TABLE IF NOT EXISTS jemma_run_log (
  id            BIGSERIAL PRIMARY KEY,
  run_rid       TEXT NOT NULL REFERENCES jemma_run(rid) ON DELETE CASCADE,
  stage_name    TEXT,
  stream        TEXT NOT NULL DEFAULT 'stdout',
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jemma_run_log_stream_chk CHECK (stream IN ('stdout','stderr','system')),
  CONSTRAINT jemma_run_log_stage_chk
    CHECK (stage_name IS NULL OR stage_name IN ('setup','lint','test','build','publish'))
);

CREATE INDEX IF NOT EXISTS jemma_run_log_run_id_idx ON jemma_run_log(run_rid, id);

CREATE TABLE IF NOT EXISTS function_registry_function (
  rid             TEXT PRIMARY KEY,
  repository_rid  TEXT NOT NULL,
  api_name         TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at       TIMESTAMPTZ,
  UNIQUE(repository_rid, source_path)
);

CREATE INDEX IF NOT EXISTS function_registry_function_api_idx
  ON function_registry_function(repository_rid, api_name) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS function_registry_function_version (
  function_rid       TEXT NOT NULL REFERENCES function_registry_function(rid),
  semver              TEXT NOT NULL,
  branch              TEXT NOT NULL,
  release_version_rid TEXT NOT NULL,
  commit_sha          TEXT NOT NULL,
  source_path         TEXT NOT NULL,
  artifact_sha256     TEXT NOT NULL,
  signature           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(function_rid, branch, semver)
);

CREATE INDEX IF NOT EXISTS function_registry_function_version_release_idx
  ON function_registry_function_version(release_version_rid);
