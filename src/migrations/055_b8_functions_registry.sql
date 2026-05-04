-- ----------------------------------------------------------------------------
-- 055 — B8 Functions Registry DDL.
--
-- Spec §B8 reference DDL was extended for:
--   * runtime CHECK enum
--   * state CHECK enum (AVAILABLE|YANKED)
--   * unique index on (repository_rid, branch, semver) — enforces immutability
--   * commit_sha CHECK regex
--   * artifact_sha256 CHECK regex
--   * is_preview NOT NULL — branch-aware preview semantics
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS function_version (
  rid               TEXT PRIMARY KEY,
  repository_rid    TEXT NOT NULL,
  branch            TEXT NOT NULL,
  is_preview        BOOLEAN NOT NULL,
  semver            TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  runtime           TEXT NOT NULL,
  artifact_blob_id  TEXT NOT NULL,
  artifact_sha256   TEXT NOT NULL,
  artifact_bytes    BIGINT NOT NULL,
  manifest_json     JSONB NOT NULL,
  published_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL DEFAULT 'AVAILABLE',
  yanked_at         TIMESTAMPTZ,
  yank_reason       TEXT,
  CONSTRAINT function_version_runtime_chk
    CHECK (runtime IN ('NODE_20','PY_311')),
  CONSTRAINT function_version_state_chk
    CHECK (state IN ('AVAILABLE','YANKED')),
  CONSTRAINT function_version_commit_sha_chk
    CHECK (commit_sha ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT function_version_artifact_sha256_chk
    CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT function_version_bytes_chk
    CHECK (artifact_bytes >= 0),
  CONSTRAINT function_version_yank_lifecycle_chk
    CHECK (
      (state = 'AVAILABLE' AND yanked_at IS NULL AND yank_reason IS NULL)
      OR (state = 'YANKED' AND yanked_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS function_version_repo_semver_branch
  ON function_version(repository_rid, branch, semver);

CREATE INDEX IF NOT EXISTS function_version_repo_branch_idx
  ON function_version(repository_rid, branch, published_at DESC);

CREATE INDEX IF NOT EXISTS function_version_state_idx
  ON function_version(state)
  WHERE state = 'YANKED';
