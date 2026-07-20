-- ---------------------------------------------------------------------------
-- Migration 114: Developer Console production control-plane hardening
-- ---------------------------------------------------------------------------

ALTER TABLE third_party_applications
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE third_party_applications
  ADD COLUMN IF NOT EXISTS row_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE third_party_applications
  ADD COLUMN IF NOT EXISTS identity_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE third_party_applications
  ADD COLUMN IF NOT EXISTS identity_error TEXT;

-- Remove the historical capture-only row from every fully migrated
-- environment. Demo data must be created by an explicit non-production seed,
-- never as a side effect of schema migration.
DELETE FROM third_party_applications
WHERE id = '3656c139-3fcc-400e-a962-6057512ee536'
  AND creator_id = 'seed-icyimpaye'
  AND keycloak_client_uuid IS NULL;

ALTER TABLE third_party_applications
  DROP CONSTRAINT IF EXISTS third_party_applications_identity_state_check;
ALTER TABLE third_party_applications
  ADD CONSTRAINT third_party_applications_identity_state_check
  CHECK (identity_state IN ('provisioning', 'ready', 'delete_pending', 'error'));

UPDATE third_party_applications
SET tenant_id = COALESCE(NULLIF(organization_id, ''), 'default')
WHERE tenant_id = 'default' AND organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tpa_tenant_modified
  ON third_party_applications (tenant_id, last_modified_at DESC)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tpa_tenant_creator_name_active
  ON third_party_applications (tenant_id, creator_id, lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS tpa_application_members (
  application_id UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
  granted_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_tpa_members_principal
  ON tpa_application_members (tenant_id, principal_id, application_id);

INSERT INTO tpa_application_members (
  application_id, tenant_id, principal_id, role, granted_by
)
SELECT id, tenant_id, creator_id, 'owner', creator_id
FROM third_party_applications
WHERE deleted_at IS NULL
ON CONFLICT (application_id, principal_id) DO UPDATE
SET role = 'owner', tenant_id = EXCLUDED.tenant_id, updated_at = now();

CREATE TABLE IF NOT EXISTS tpa_idempotency_keys (
  tenant_id             TEXT NOT NULL,
  principal_id          TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  request_hash          TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'in_progress'
                          CHECK (state IN ('in_progress', 'completed', 'failed')),
  application_id        UUID REFERENCES third_party_applications(id) ON DELETE SET NULL,
  response_ciphertext   BYTEA,
  wrapped_dek           BYTEA,
  kms_adapter           TEXT,
  kms_key_id            TEXT,
  error_code            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (tenant_id, principal_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tpa_idempotency_expiry
  ON tpa_idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS tpa_reconciliation_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  application_id    UUID REFERENCES third_party_applications(id) ON DELETE CASCADE,
  job_type          TEXT NOT NULL CHECK (job_type IN (
                      'identity_provision', 'identity_delete', 'identity_rotate',
                      'share_apply', 'share_revoke'
                    )),
  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempt_count     INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 10,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpa_reconciliation_ready
  ON tpa_reconciliation_jobs (state, next_attempt_at)
  WHERE state IN ('pending', 'failed');

CREATE TABLE IF NOT EXISTS tpa_audit_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  tenant_id       TEXT NOT NULL,
  application_id  UUID REFERENCES third_party_applications(id) ON DELETE SET NULL,
  actor_id        TEXT NOT NULL,
  actor_name      TEXT NOT NULL,
  action          TEXT NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('SUCCESS', 'FAILURE')),
  request_id      TEXT,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpa_audit_tenant_time
  ON tpa_audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpa_audit_application_time
  ON tpa_audit_events (application_id, created_at DESC);

COMMENT ON TABLE tpa_application_members IS
  'Application-level ACL. Access is deny-by-default unless the caller is a member or superadmin.';
COMMENT ON TABLE tpa_idempotency_keys IS
  'Durable create-operation idempotency with KMS-wrapped encrypted response bodies.';
COMMENT ON TABLE tpa_reconciliation_jobs IS
  'Durable cross-system reconciliation work for identity and policy changes.';
COMMENT ON TABLE tpa_audit_events IS
  'Append-only Developer Console security and lifecycle audit stream.';
