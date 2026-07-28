-- Bind every ontology to one tenant. Existing single-tenant installations
-- retain their current behaviour under the explicit "default" tenant.
ALTER TABLE ontology
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';

-- Migration 100 intentionally collapsed early deployments to one ontology.
-- Tenant isolation requires one ontology namespace per tenant, so remove the
-- constant-expression singleton guard before accepting tenant-scoped rows.
DROP INDEX IF EXISTS uq_ontology_singleton;

CREATE INDEX IF NOT EXISTS idx_ontology_tenant_id
  ON ontology (tenant_id, ontology_id);

DROP INDEX IF EXISTS idx_ontology_display_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_tenant_display_name
  ON ontology (tenant_id, display_name);
