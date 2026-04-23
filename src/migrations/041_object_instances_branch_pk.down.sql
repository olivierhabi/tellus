-- Down migration 041 — revert object_instances PK extension.
--
-- Offline operation — schedule during a maintenance window.
BEGIN;

DROP INDEX IF EXISTS idx_object_instances_branch_type;

-- Drop the new 4-column PK and restore the 3-column version.
ALTER TABLE object_instances DROP CONSTRAINT IF EXISTS object_instances_pkey;
ALTER TABLE object_instances
  ADD CONSTRAINT object_instances_pkey
  PRIMARY KEY (ontology_id, object_type_api_name, primary_key);

-- Drop the FK constraint and then the column.
ALTER TABLE object_instances DROP CONSTRAINT IF EXISTS object_instances_branch_fk;
ALTER TABLE object_instances DROP COLUMN IF EXISTS branch_id;

COMMIT;
