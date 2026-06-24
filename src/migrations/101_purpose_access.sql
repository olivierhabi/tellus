-- ---------------------------------------------------------------------------
-- Migration 101: Purpose-based access control (FOUNDRY-GAPS §8)
--
-- Foundry-style purpose gating: access to GOVERNED data is conditional on a
-- DECLARED purpose, and the declared purpose is recorded in the read-audit
-- row for every access it authorizes.
--
-- Tables:
--   access_purpose — the catalogue of declared purposes per ontology. Each
--                    purpose lists the read-audit categories it may exercise
--                    (allowed_categories ⊆ {object.read, object.search,
--                    object.search_around, object.traverse, link.list}) and
--                    may carry an expiry (time-boxed investigations).
--   purpose_grant  — which principals (user|group) may invoke a purpose.
--                    Soft-revocation via revoked_at so the grant history is
--                    preserved for forensics (same idiom as pipeline_acl
--                    audit trail, but in-table).
--
-- Governed flags:
--   foundry_datasets.governed_purpose_required — dataset-level gate.
--   object_type.governed_purpose_required      — object-type-level gate
--     (the data-plane read routes are keyed by object type, so this is the
--     flag the purposeGate middleware consults).
--
-- Read-audit integration: the declared purpose is carried in the audit row's
-- JSONB `parameters.declared_purpose` and `metadata.purpose`. NO new column
-- is added to action_audit_log on purpose (pun intended): the hash chain
-- (migration 036) covers the serialized row, and JSONB payloads are already
-- chained — adding a column would force a chain-format version bump for no
-- queryability we cannot get from `metadata->>'purpose'`.
--
-- NOTE on ordering: this file references foundry_datasets, which is created
-- by src/foundryMigrate.ts. When migrate.ts's forward scan runs before
-- foundryMigrate on a fresh database, the 42P01 deferral path re-applies
-- this file in foundryMigrate's own scan (see migrate.ts DEFERRABLE_SQLSTATES).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS access_purpose (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id         UUID NOT NULL,
  api_name            TEXT NOT NULL CHECK (char_length(api_name) BETWEEN 1 AND 128),
  display_name        TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  description         TEXT,
  -- Read-audit categories this purpose may exercise. Empty array = the
  -- purpose exists but authorizes nothing (useful while drafting).
  allowed_categories  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at          TIMESTAMPTZ,
  created_by          TEXT NOT NULL DEFAULT 'system',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at         TIMESTAMPTZ,
  CONSTRAINT access_purpose_api_name_per_ontology UNIQUE (ontology_id, api_name)
);

COMMENT ON TABLE access_purpose IS
  'Declared purposes for purpose-based access control (FOUNDRY-GAPS §8). Governed reads require an X-Tellus-Purpose header naming one of these.';
COMMENT ON COLUMN access_purpose.allowed_categories IS
  'Read-audit categories (object.read, object.search, object.search_around, object.traverse, link.list) this purpose authorizes.';

CREATE INDEX IF NOT EXISTS idx_access_purpose_ontology
  ON access_purpose (ontology_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS purpose_grant (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose_id      UUID NOT NULL REFERENCES access_purpose(id) ON DELETE CASCADE,
  principal_id    TEXT NOT NULL,
  principal_type  TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  granted_by      TEXT NOT NULL DEFAULT 'system',
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);

COMMENT ON TABLE purpose_grant IS
  'Principal grants for access_purpose. Soft-revoked (revoked_at) to preserve the grant history for audit.';

CREATE INDEX IF NOT EXISTS idx_purpose_grant_purpose
  ON purpose_grant (purpose_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_purpose_grant_principal
  ON purpose_grant (principal_id, principal_type) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Governed flags.
-- ---------------------------------------------------------------------------
ALTER TABLE foundry_datasets
  ADD COLUMN IF NOT EXISTS governed_purpose_required BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN foundry_datasets.governed_purpose_required IS
  'When TRUE and TELLUS_PURPOSE_ENFORCEMENT=on, reads of data backed by this dataset require a declared purpose (X-Tellus-Purpose).';

ALTER TABLE object_type
  ADD COLUMN IF NOT EXISTS governed_purpose_required BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN object_type.governed_purpose_required IS
  'When TRUE and TELLUS_PURPOSE_ENFORCEMENT=on, data-plane reads of this object type require a declared purpose (X-Tellus-Purpose).';
