-- ---------------------------------------------------------------------------
-- 086 — Durable Stemma storage.
--
-- The Code Repositories service previously stored all git content (branches,
-- file blobs, HEADs) in an in-memory adapter (InMemoryStemma). That state is
-- process-local and lost on every restart, so committed functions vanished and
-- the durable `code_repository_branch_cache` drifted out of sync with the live
-- (re-scaffolded) tree, producing 412 StaleRefHead on commit.
--
-- These tables back `PostgresStemma`, a durable StemmaAdapter that mirrors the
-- in-memory adapter's semantics (sha-shaped HEADs, CAS on parentSha, tree
-- synthesis) but persists to Postgres, so repository content survives restarts.
-- ---------------------------------------------------------------------------

-- One row per repository. `tombstoned` is the soft-delete flag (reads of a
-- tombstoned repo return branch-not-found, mirroring InMemoryStemma).
CREATE TABLE IF NOT EXISTS coderepo_stemma_repo (
  repository_rid TEXT PRIMARY KEY,
  tombstoned     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (repository, branch). `head_sha` is the branch's current HEAD,
-- updated atomically with each commit (CAS against the caller's parentSha).
CREATE TABLE IF NOT EXISTS coderepo_stemma_branch (
  repository_rid TEXT NOT NULL REFERENCES coderepo_stemma_repo(repository_rid) ON DELETE CASCADE,
  branch         TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  PRIMARY KEY (repository_rid, branch)
);

-- One row per file blob on a branch. The working tree is the full set of rows
-- for (repository_rid, branch); directory (tree) entries are synthesized on
-- read. `sha` is the sha1 of the content (git-shaped, not git-compatible).
CREATE TABLE IF NOT EXISTS coderepo_stemma_blob (
  repository_rid TEXT NOT NULL,
  branch         TEXT NOT NULL,
  path           TEXT NOT NULL,
  content        BYTEA NOT NULL,
  sha            TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT '100644',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, branch, path),
  CONSTRAINT coderepo_stemma_blob_branch_fk
    FOREIGN KEY (repository_rid, branch)
    REFERENCES coderepo_stemma_branch(repository_rid, branch) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS coderepo_stemma_blob_by_branch
  ON coderepo_stemma_blob (repository_rid, branch);

COMMENT ON TABLE coderepo_stemma_repo IS
  'Durable Stemma — one row per repository (086). Replaces the in-memory adapter so committed content survives restarts.';
