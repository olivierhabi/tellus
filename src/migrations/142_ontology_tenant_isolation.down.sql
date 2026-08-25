DROP INDEX IF EXISTS idx_ontology_tenant_display_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_display_name
  ON ontology (display_name);
DROP INDEX IF EXISTS idx_ontology_tenant_id;
ALTER TABLE ontology DROP COLUMN IF EXISTS tenant_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ontology_singleton
  ON ontology ((true));
