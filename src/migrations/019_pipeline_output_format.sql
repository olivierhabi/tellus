-- ---------------------------------------------------------------------------
-- Task PB-B3 — Output format migration (CSV → Parquet, Iceberg coming in PB-B4).
--
-- Columns added:
--   pipelines.output_format          ('csv','parquet','iceberg') default 'csv'
--   foundry_datasets.format          tracks the on-disk shape of the dataset
--   foundry_datasets.row_count_exact BIGINT — populated from Parquet footer
--                                     counts rather than CSV line estimates.
--   dataset_columns.logical_type     TEXT — Parquet logical type annotation
--                                     (STRING, INT64, DECIMAL(p,s),
--                                     TIMESTAMP_MICROS, DATE, BOOL).
--
-- Defaults:
--   * `output_format` stays on 'csv' for one release so existing frontends
--     keep producing byte-identical CSV outputs. PB-B4 flips the default to
--     'parquet' once Iceberg catalog bootstrap lands.
--   * `format` backfills to 'csv' for every existing row so the lazy CSV
--     transcoder on GET /datasets/:id/download can short-circuit when the
--     dataset is already CSV.
-- ---------------------------------------------------------------------------

-- 1. pipelines.output_format ----------------------------------------------

ALTER TABLE pipelines
    ADD COLUMN IF NOT EXISTS output_format TEXT NOT NULL DEFAULT 'csv';

ALTER TABLE pipelines
    DROP CONSTRAINT IF EXISTS pipelines_output_format_check;

ALTER TABLE pipelines
    ADD CONSTRAINT pipelines_output_format_check
    CHECK (output_format IN ('csv', 'parquet', 'iceberg'));

-- 2. foundry_datasets.format + row_count_exact ---------------------------

ALTER TABLE foundry_datasets
    ADD COLUMN IF NOT EXISTS format TEXT;

UPDATE foundry_datasets
   SET format = 'csv'
 WHERE format IS NULL;

ALTER TABLE foundry_datasets
    ALTER COLUMN format SET NOT NULL;
ALTER TABLE foundry_datasets
    ALTER COLUMN format SET DEFAULT 'csv';

ALTER TABLE foundry_datasets
    DROP CONSTRAINT IF EXISTS foundry_datasets_format_check;
ALTER TABLE foundry_datasets
    ADD CONSTRAINT foundry_datasets_format_check
    CHECK (format IN ('csv', 'parquet', 'iceberg'));

-- Parquet row counts are authoritative (read from the footer, not
-- estimated from line counts). NULL for legacy CSV rows; Parquet writer
-- populates on deploy.
ALTER TABLE foundry_datasets
    ADD COLUMN IF NOT EXISTS row_count_exact BIGINT;

-- 3. dataset_columns.logical_type ----------------------------------------

ALTER TABLE dataset_columns
    ADD COLUMN IF NOT EXISTS logical_type TEXT;
