-- B2 — connectivity_credentials + connectivity_credentials_audit
-- Tellus PostgreSQL Connectivity spec v2 §90-126
--
-- Envelope encryption: the plaintext credential (password, client key, etc.)
-- is sealed with a per-row DEK (32 bytes). The DEK is wrapped by a tenant-
-- scoped KEK in a pluggable KMS (LocalAesGcmAdapter by default; Vault/
-- AWS/GCP for prod). Both ciphertexts live in this row; the unwrap is the
-- only step that crosses the KMS trust boundary.
--
-- Versioning: rotation bumps `version` and writes a new row; reads always
-- target the highest version per connection_rid. An audit row is written
-- on EVERY unwrap (B2 §117.3).

CREATE TABLE IF NOT EXISTS connectivity_credentials (
  id                     BIGSERIAL PRIMARY KEY,
  connection_rid         TEXT NOT NULL,
  tenant                 TEXT NOT NULL,
  version                INTEGER NOT NULL,
  /* AES-256-GCM ciphertext of plaintext payload (12-byte IV || ciphertext || 16-byte tag). */
  ciphertext             BYTEA NOT NULL,
  /* Per-row DEK wrapped by tenant KEK via configured KMS. */
  wrapped_dek            BYTEA NOT NULL,
  /* KMS adapter id ('local-aesgcm', 'vault-transit', 'aws-kms', 'gcp-kms'). */
  kms_adapter            TEXT NOT NULL,
  /* KMS key identifier (URI, ARN, key name). Opaque to this table. */
  kms_key_id             TEXT NOT NULL,
  /* Caller-supplied tag for which credential field this row holds. */
  field                  TEXT NOT NULL CHECK (field IN ('password', 'client_key', 'service_account_json', 'token', 'other')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             TEXT NOT NULL,
  superseded_at          TIMESTAMPTZ,
  UNIQUE (connection_rid, field, version)
);

CREATE INDEX IF NOT EXISTS connectivity_credentials_by_rid
  ON connectivity_credentials (connection_rid, field, version DESC);

CREATE INDEX IF NOT EXISTS connectivity_credentials_by_tenant
  ON connectivity_credentials (tenant, created_at DESC);

/* Append-only audit table. Every write (create / rotate / supersede) AND
   every read/unwrap inserts one row here. Used by the §116.1 plaintext-scan
   regression to confirm no plaintext leaks into the audit surface. */
CREATE TABLE IF NOT EXISTS connectivity_credentials_audit (
  id                     BIGSERIAL PRIMARY KEY,
  connection_rid         TEXT NOT NULL,
  tenant                 TEXT NOT NULL,
  field                  TEXT NOT NULL,
  version                INTEGER NOT NULL,
  /* 'create' | 'rotate' | 'supersede' | 'read' | 'unwrap' | 'delete' */
  operation              TEXT NOT NULL,
  /* Actor that performed the op: user UUID, workload JWT subject, or system. */
  actor                  TEXT NOT NULL,
  /* Outcome: 'success' or 'failure'. */
  outcome                TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  /* Operator-visible reason (never carries plaintext). */
  reason                 TEXT,
  /* Workload JWT scopes when this was an unwrap call. */
  scopes                 TEXT[],
  client_ip              INET,
  request_id             TEXT,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connectivity_credentials_audit_by_rid
  ON connectivity_credentials_audit (connection_rid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS connectivity_credentials_audit_by_actor
  ON connectivity_credentials_audit (actor, occurred_at DESC);
