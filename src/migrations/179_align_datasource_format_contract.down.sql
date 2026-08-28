DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM backing_datasource WHERE file_format IN ('iceberg', 'stream')
  ) THEN
    RAISE EXCEPTION
      'Cannot roll back migration 179: backing_datasource contains iceberg/stream rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM foundry_datasets WHERE format = 'json'
  ) THEN
    RAISE EXCEPTION
      'Cannot roll back migration 179: foundry_datasets contains json rows';
  END IF;

  ALTER TABLE backing_datasource
    DROP CONSTRAINT IF EXISTS backing_datasource_file_format_check;
  ALTER TABLE backing_datasource
    ADD CONSTRAINT backing_datasource_file_format_check
    CHECK (file_format IN ('csv', 'json', 'parquet'));

  ALTER TABLE foundry_datasets
    DROP CONSTRAINT IF EXISTS foundry_datasets_format_check;
  ALTER TABLE foundry_datasets
    ADD CONSTRAINT foundry_datasets_format_check
    CHECK (format IN ('csv', 'parquet', 'iceberg', 'stream'));
END $$;

