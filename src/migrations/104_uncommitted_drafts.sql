-- ---------------------------------------------------------------------------
-- 104_uncommitted_drafts.sql
--
-- Per-user, per-branch, PRE-COMMIT draft store for code repositories.
--
-- The repo browser's dirty buffer (the Code Assistant's propose_file flow,
-- or a buffer edited in Monaco) was previously in-memory only — a reload
-- lost every uncommitted edit. This table is the durable, backend-backed
-- analogue: it stores each user's uncommitted file drafts so they survive
-- across browsers/sessions, WITHOUT creating a git commit (rows are deleted
-- by the frontend the moment the user commits via Source Control).
--
-- Mirrors coderepo_stemma_blob (086) — same content/path/mode/updated_at
-- shape — but keyed by `principal_sub` so each user's uncommitted work is
-- private until they commit. `principal_sub` is the same derived UUID the
-- commit route uses (isUuidV4?userId:derivePrincipalSubUuid), so test-mode
-- non-UUID principals resolve stably; it is deliberately NOT a FK to users
-- (derived/test UUIDs are not present in `users`, matching the code-repos
-- convention for principal_sub in 051/053).
--
-- `base_sha`/`base_content` snapshot the committed file at draft-creation
-- time so the post-reload diff is exact (NULL for a new-file "add" draft).
-- Branch is plain text (no FK to coderepo_stemma_branch) mirroring
-- code_repository_branch_cache (053) — a draft for a since-deleted branch
-- is harmless and naturally ages out on commit/clear.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_repository_draft (
  draft_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_sub   UUID        NOT NULL,
  repository_rid  TEXT        NOT NULL REFERENCES code_repository(rid) ON DELETE CASCADE,
  branch          TEXT        NOT NULL,
  path            TEXT        NOT NULL,
  content         BYTEA       NOT NULL,
  base_sha        TEXT,
  base_content    BYTEA,
  mode            TEXT        NOT NULL DEFAULT '100644',
  version         BIGINT      NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_repository_draft_unique
    UNIQUE (principal_sub, repository_rid, branch, path)
);

CREATE INDEX IF NOT EXISTS code_repository_draft_lookup
  ON code_repository_draft (principal_sub, repository_rid, branch);
