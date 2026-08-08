-- 164_function_publish_authz.sql
-- Function publish authorization: replace the static FUNCTION_TRUSTED_AUTHOR_IDS
-- env allowlist with a database-backed grant model + append-only audit log.
--
-- Context: the Function executor (worker_threads + vm) is NOT an
-- untrusted-code sandbox, so publication of executable Functions is a
-- security-sensitive, gated operation. Until sandboxed execution lands,
-- publish rights are managed via:
--   1. a Keycloak role (FUNCTION_PUBLISH_ROLE, default "function:publish")
--   2. these DB grants (global or per-repository scope)
--   3. the legacy FUNCTION_TRUSTED_AUTHOR_IDS env allowlist (deprecated
--      fallback during migration)
-- and every allow/deny decision is persisted in function_publish_audit_log.
--
-- Fail closed: no role + no active grant + no env entry => deny.

CREATE TABLE IF NOT EXISTS function_publish_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('local_user', 'keycloak_sub')),
  subject_id  TEXT NOT NULL,
  scope_type  TEXT NOT NULL CHECK (scope_type IN ('global', 'repository')),
  scope_rid   TEXT,
  granted_by  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT function_publish_grants_scope_chk CHECK (
    (scope_type = 'global' AND scope_rid IS NULL)
    OR (scope_type = 'repository' AND scope_rid IS NOT NULL)
  ),
  CONSTRAINT function_publish_grants_revoked_chk CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL)
  ),
  CONSTRAINT function_publish_grants_subject_len_chk CHECK (
    length(subject_id) BETWEEN 1 AND 512
  ),
  CONSTRAINT function_publish_grants_reason_len_chk CHECK (
    length(btrim(reason)) BETWEEN 1 AND 2000
  )
);

-- At most one ACTIVE grant per (subject, scope). Revoked grants fall out of
-- the predicate so a revoke-then-regrant cycle is possible without deleting
-- history.
CREATE UNIQUE INDEX IF NOT EXISTS function_publish_grants_active_uniq
  ON function_publish_grants (subject_type, subject_id, scope_type, COALESCE(scope_rid, ''))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS function_publish_grants_subject_idx
  ON function_publish_grants (subject_id);

-- Append-only audit trail for every publish authorization decision and every
-- grant lifecycle event. Application code MUST only INSERT into this table
-- (and SELECT); there are intentionally no update/delete paths.
CREATE TABLE IF NOT EXISTS function_publish_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'publish_allowed',
    'publish_denied',
    'grant_created',
    'grant_revoked',
    'grant_expired_denial'
  )),
  subject_type    TEXT CHECK (subject_type IS NULL OR subject_type IN ('local_user', 'keycloak_sub')),
  subject_id      TEXT,
  keycloak_sub    TEXT,
  local_user_id   TEXT,
  repository_rid  TEXT,
  release_tag     TEXT,
  decision_source TEXT CHECK (decision_source IS NULL OR decision_source IN (
    'keycloak_role',
    'db_grant',
    'env_allowlist',
    'open_development',
    'denied'
  )),
  grant_id        uuid REFERENCES function_publish_grants (id),
  actor_id        TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS function_publish_audit_log_created_idx
  ON function_publish_audit_log (created_at DESC, id);
CREATE INDEX IF NOT EXISTS function_publish_audit_log_subject_idx
  ON function_publish_audit_log (subject_id);
CREATE INDEX IF NOT EXISTS function_publish_audit_log_repo_idx
  ON function_publish_audit_log (repository_rid);
CREATE INDEX IF NOT EXISTS function_publish_audit_log_event_idx
  ON function_publish_audit_log (event_type);
