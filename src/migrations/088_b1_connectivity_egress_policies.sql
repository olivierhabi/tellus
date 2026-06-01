-- B1 — connectivity.egress_policies
-- Tellus PostgreSQL Connectivity spec v2 — named egress policy resource.
--
-- A reusable, named network egress allowlist that connections may reference by
-- RID instead of (or in addition to) carrying an inline allowlist. Named
-- policies carry an approval workflow: a policy is only enforceable once its
-- status is APPROVED, so a security reviewer gates which destinations the
-- platform may reach. Versioned for ETag/If-Match; soft-deleted.

CREATE TABLE IF NOT EXISTS connectivity_egress_policies (
  rid                     TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  -- Approval workflow: a policy is only usable by a connection once APPROVED.
  status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  allowlist               JSONB NOT NULL DEFAULT '[]'::JSONB,
  version                 BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT NOT NULL,
  approved_at             TIMESTAMPTZ,
  approved_by             TEXT,
  deleted_at              TIMESTAMPTZ,
  deleted_by              TEXT,
  CONSTRAINT connectivity_egress_policies_rid_format
    CHECK (rid ~ '^ri\.magritte\.main\.egress-policy\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- Unique policy name within a tenant, excluding soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS connectivity_egress_policies_unique_name_in_tenant
  ON connectivity_egress_policies (tenant, name)
  WHERE deleted_at IS NULL;

-- List queries: by tenant, newest first.
CREATE INDEX IF NOT EXISTS connectivity_egress_policies_by_tenant
  ON connectivity_egress_policies (tenant, created_at DESC)
  WHERE deleted_at IS NULL;

-- A connection may reference a named egress policy by RID. Nullable: a
-- connection with no reference keeps using its inline egress_policy allowlist.
-- ON DELETE RESTRICT: a policy in use by a live connection cannot be deleted.
ALTER TABLE connectivity_connections
  ADD COLUMN IF NOT EXISTS egress_policy_rid TEXT
    REFERENCES connectivity_egress_policies(rid) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS connectivity_connections_by_egress_policy
  ON connectivity_connections (egress_policy_rid)
  WHERE egress_policy_rid IS NOT NULL AND deleted_at IS NULL;
