DROP INDEX IF EXISTS idx_tpa_client_id;
DROP TABLE IF EXISTS tpa_service_shares;
DROP INDEX IF EXISTS idx_tpa_metrics_app_metric_ts;
DROP INDEX IF EXISTS idx_tpa_metrics_app_ts;
DROP TABLE IF EXISTS tpa_metrics_points;
ALTER TABLE tpa_sdk_versions DROP COLUMN IF EXISTS ontology_id;
ALTER TABLE tpa_sdk_versions DROP COLUMN IF EXISTS resource_snapshot;
ALTER TABLE tpa_sdk_versions DROP COLUMN IF EXISTS package_files;
-- kind check reverts to original three kinds only if no interface rows remain
DELETE FROM tpa_ontology_resources WHERE kind = 'interface';
ALTER TABLE tpa_ontology_resources DROP CONSTRAINT IF EXISTS tpa_ontology_resources_kind_check;
ALTER TABLE tpa_ontology_resources
  ADD CONSTRAINT tpa_ontology_resources_kind_check
  CHECK (kind IN ('object_type', 'action_type', 'function'));
