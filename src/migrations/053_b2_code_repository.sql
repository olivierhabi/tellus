-- ---------------------------------------------------------------------------
-- B2 — Code Repository Service DDL.
--
-- Spec §B2 lines 261-289:
--   code_repository:                metadata layer above Stemma
--   code_repository_branch_cache:   per-branch view (head_sha, lag, etc.)
--
-- Adds:
--   - code_repository_saga_ledger:  per-create-saga ledger (B2-C-25, B2-C-50)
--                                   tracks idempotency-key, current state,
--                                   compass+stemma+commit RIDs.
--
-- Spec contracts:
--   B2-C-10  state CHECK ('ACTIVE','ARCHIVED','TRASHED')
--   B2-C-11  case-insensitive unique (parent_folder_rid, lower(display_name))
--           WHERE state='ACTIVE'
--   B2-C-12  resource_version >= 1
--   B2-C-13  branch_cache PK(repository_rid, branch_name)
--   B2-C-14  saga_ledger.state CHECK matches the SAGA_STATES enum
--   B2-C-15  saga_ledger unique (idempotency_key, principal_sub) — replay
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_repository (
  rid                TEXT PRIMARY KEY,
  display_name       TEXT NOT NULL,
  parent_folder_rid  TEXT NOT NULL,
  project_rid        TEXT NOT NULL,
  template_id        TEXT NOT NULL,
  template_version   TEXT NOT NULL,
  default_branch     TEXT NOT NULL DEFAULT 'main',
  settings_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  state              TEXT NOT NULL CHECK (state IN ('ACTIVE','ARCHIVED','TRASHED')),
  created_by         UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resource_version   BIGINT NOT NULL DEFAULT 1 CHECK (resource_version >= 1)
);

-- B2-C-11: case-insensitive name uniqueness within a parent folder, scoped
-- to ACTIVE only so that a TRASHED repo doesn't block a new same-name repo.
CREATE UNIQUE INDEX IF NOT EXISTS code_repository_parent_name_active_uniq
  ON code_repository(parent_folder_rid, lower(display_name))
  WHERE state = 'ACTIVE';

-- Common lookup: list repos by parent folder, ordered.
CREATE INDEX IF NOT EXISTS code_repository_parent_folder_idx
  ON code_repository(parent_folder_rid, created_at DESC)
  WHERE state = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Branch cache (eventual consistency from B10 events; ≤ 5s P99 lag).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_repository_branch_cache (
  repository_rid     TEXT NOT NULL REFERENCES code_repository(rid) ON DELETE CASCADE,
  branch_name        TEXT NOT NULL,
  head_sha           TEXT,
  is_protected       BOOLEAN NOT NULL DEFAULT FALSE,
  last_commit_at     TIMESTAMPTZ,
  last_commit_author UUID,
  open_pr_count      INT NOT NULL DEFAULT 0 CHECK (open_pr_count >= 0),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, branch_name)
);

-- Quick "list protected branches for a repo" lookup.
CREATE INDEX IF NOT EXISTS code_repository_branch_cache_protected_idx
  ON code_repository_branch_cache(repository_rid)
  WHERE is_protected = TRUE;

-- ---------------------------------------------------------------------------
-- Saga ledger (per-create-call durable state for the 4-step saga).
--
-- One row per (idempotency_key, principal_sub) pair. The ledger row is
-- the single source of truth for resumption/idempotency. Inserted at INIT,
-- updated as the saga advances; never deleted.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_repository_saga_ledger (
  saga_id              TEXT PRIMARY KEY,                       -- ULID
  idempotency_key      UUID NOT NULL,
  principal_sub        UUID NOT NULL,
  display_name         TEXT NOT NULL,
  parent_folder_rid    TEXT NOT NULL,
  template_id          TEXT NOT NULL,
  template_version     TEXT NOT NULL,
  default_branch       TEXT NOT NULL DEFAULT 'main',
  state                TEXT NOT NULL CHECK (state IN (
                         'INIT',
                         'COMPASS_RESERVED',
                         'STEMMA_CREATED',
                         'TEMPLATE_PUSHED',
                         'ACTIVE',
                         'COMPENSATING',
                         'ROLLED_BACK',
                         'INIT_FAILED'
                       )),
  compass_resource_rid TEXT,
  stemma_repository_rid TEXT,
  initial_commit_sha   TEXT,
  last_error_name      TEXT,                                   -- last CodeRepos:* error if any
  last_error_envelope  JSONB,                                  -- full §1.3 envelope
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS code_repository_saga_ledger_idem_uniq
  ON code_repository_saga_ledger(idempotency_key, principal_sub);

-- Quick "find saga by stemma RID" reverse lookup (used by re-init).
CREATE INDEX IF NOT EXISTS code_repository_saga_ledger_stemma_idx
  ON code_repository_saga_ledger(stemma_repository_rid)
  WHERE stemma_repository_rid IS NOT NULL;

-- Quick "find sagas needing retry" filter.
CREATE INDEX IF NOT EXISTS code_repository_saga_ledger_init_failed_idx
  ON code_repository_saga_ledger(updated_at)
  WHERE state = 'INIT_FAILED';

COMMENT ON TABLE code_repository_saga_ledger IS
  'B2 createRepository saga ledger. One row per (idempotency_key, principal_sub). State transitions per src/services/codeRepository/saga/stateMachine.ts.';
