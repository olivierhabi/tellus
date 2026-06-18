-- ===========================================================================
-- 031_stemma_ddl.sql — B1 Stemma Git Server schema
--
-- Spec: tasks/code-repository/code-repository-tasks.md:147-197.
-- Contract IDs: B1-C-20 (state CHECK), B1-C-21 (ref CAS columns),
-- B1-C-23 (packfile content-addressing), B1-C-25 (stateless nodes).
--
-- Down-migration: 031_stemma_ddl.down.sql (reversible — required by DoD).
-- ===========================================================================

BEGIN;

-- ----- stemma_repository -----------------------------------------------------
CREATE TABLE IF NOT EXISTS stemma_repository (
  rid               TEXT PRIMARY KEY,
  default_branch    TEXT NOT NULL DEFAULT 'main',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  state             TEXT NOT NULL CHECK (state IN ('ACTIVE','TOMBSTONED','PURGED')),
  resource_version  BIGINT NOT NULL DEFAULT 1
);

COMMENT ON TABLE stemma_repository IS
  'B1 Stemma — one row per logical Tellus repository. RID format ri.stemma.main.repository.<uuidv4>.';
COMMENT ON COLUMN stemma_repository.state IS
  'B1-C-20: ACTIVE → TOMBSTONED → PURGED only. Soft delete after 30d hard purge.';
COMMENT ON COLUMN stemma_repository.resource_version IS
  'G-C-19: monotonically increasing per-row version, bumped on every write. Surfaced as W/"<n>" ETag.';

-- ----- stemma_ref ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stemma_ref (
  repository_rid    TEXT NOT NULL REFERENCES stemma_repository(rid) ON DELETE RESTRICT,
  name              TEXT NOT NULL,
  target_sha        TEXT NOT NULL,
  peeled_sha        TEXT,
  is_symbolic       BOOLEAN NOT NULL DEFAULT FALSE,
  symbolic_target   TEXT,
  resource_version  BIGINT NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, name)
);

CREATE INDEX IF NOT EXISTS stemma_ref_repo_idx ON stemma_ref(repository_rid);

COMMENT ON COLUMN stemma_ref.target_sha IS
  'B1-C-21: 40-char hex SHA-1 (or SHA-256 in future). CAS column — every update is `WHERE target_sha = $expected_old`.';
COMMENT ON COLUMN stemma_ref.is_symbolic IS
  'B1-C-47: HEAD ref on empty repo is symbolic → refs/heads/main. symbolic_target populated when true.';

-- ----- stemma_packfile -------------------------------------------------------
CREATE TABLE IF NOT EXISTS stemma_packfile (
  repository_rid    TEXT NOT NULL,
  pack_id           TEXT NOT NULL,
  pack_size_bytes   BIGINT NOT NULL CHECK (pack_size_bytes > 0),
  index_size_bytes  BIGINT NOT NULL CHECK (index_size_bytes > 0),
  pack_blob_id      TEXT NOT NULL,
  index_blob_id     TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, pack_id)
);

CREATE INDEX IF NOT EXISTS stemma_packfile_repo_idx ON stemma_packfile(repository_rid, created_at DESC);

COMMENT ON TABLE stemma_packfile IS
  'B1-C-23: packfile row inserted only after `git index-pack --strict` AND content-addressable verify.';

-- ----- stemma_loose_object ---------------------------------------------------
CREATE TABLE IF NOT EXISTS stemma_loose_object (
  repository_rid    TEXT NOT NULL,
  sha               TEXT NOT NULL,
  obj_type          SMALLINT NOT NULL CHECK (obj_type IN (1,2,3,4)),
  size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
  content_blob_id   TEXT NOT NULL,
  PRIMARY KEY (repository_rid, sha)
);

COMMENT ON COLUMN stemma_loose_object.obj_type IS
  '1=commit, 2=tree, 3=blob, 4=tag (matches git object type IDs).';

-- ----- stemma_blob (large object backing) -----------------------------------
CREATE TABLE IF NOT EXISTS stemma_blob (
  blob_id           TEXT PRIMARY KEY,
  storage_uri       TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256            TEXT NOT NULL CHECK (char_length(sha256) = 64)
);

COMMENT ON TABLE stemma_blob IS
  'Backed by S3 (storage_uri = s3://...) or pg_largeobject (pglo:<oid>). Content-addressable (sha256 unique-by-convention).';

-- ----- stemma_quarantine (B1-C-24, D-2026-05-01-004) ------------------------
-- Per-push isolated quarantine. Promoted atomically to stemma_packfile +
-- stemma_loose_object via the receive-pack txn; deleted on rollback.
CREATE TABLE IF NOT EXISTS stemma_quarantine (
  quarantine_id     TEXT PRIMARY KEY,                  -- ULID per push
  repository_rid    TEXT NOT NULL REFERENCES stemma_repository(rid) ON DELETE CASCADE,
  principal_sub     UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,              -- ~ now() + 5 minutes; gc'd if abandoned
  state             TEXT NOT NULL CHECK (state IN ('OPEN','PROMOTED','REJECTED','EXPIRED'))
);

CREATE INDEX IF NOT EXISTS stemma_quarantine_expires_idx
  ON stemma_quarantine(expires_at) WHERE state = 'OPEN';

-- Idempotency table (G-C-20..23) — shared, but spec puts B1 as the first
-- task that requires Idempotency-Key on POST /repositories/{rid}:gc and on
-- the admin createRepository path.
CREATE TABLE IF NOT EXISTS code_repos_idempotency (
  idempotency_key   UUID NOT NULL,
  service           TEXT NOT NULL,
  endpoint          TEXT NOT NULL,
  request_hash      TEXT NOT NULL,                     -- sha256 hex
  response_id       TEXT NOT NULL,                     -- references the resource we created (or its serialized envelope id)
  status_code       INT  NOT NULL,
  response_body     JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,              -- created_at + 24h
  PRIMARY KEY (idempotency_key, service, endpoint)
);

CREATE INDEX IF NOT EXISTS code_repos_idempotency_expires_idx
  ON code_repos_idempotency(expires_at);

COMMENT ON TABLE code_repos_idempotency IS
  'G-C-21: 24h replay window. Same key+hash → return response_body. Same key+different hash → 409 IdempotencyConflict.';

COMMIT;
