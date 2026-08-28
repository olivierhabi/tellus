-- Keep canonical Foundry datasets and ontology datasource bindings on one
-- persisted format domain. The union retains legacy JSON bindings and all
-- formats already accepted by foundry_datasets.

ALTER TABLE foundry_datasets
  DROP CONSTRAINT IF EXISTS foundry_datasets_format_check;
ALTER TABLE foundry_datasets
  ADD CONSTRAINT foundry_datasets_format_check
  CHECK (format IN ('csv', 'json', 'parquet', 'iceberg', 'stream'));

ALTER TABLE backing_datasource
  DROP CONSTRAINT IF EXISTS backing_datasource_file_format_check;
ALTER TABLE backing_datasource
  ADD CONSTRAINT backing_datasource_file_format_check
  CHECK (file_format IN ('csv', 'json', 'parquet', 'iceberg', 'stream'));

