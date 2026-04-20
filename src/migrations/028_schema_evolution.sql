-- ---------------------------------------------------------------------------
-- Task PB-B10 — Schema evolution + Iceberg migration + Funnel schemaChanged.
--
-- foundry_datasets.last_output_schema_fingerprint
--   Sha-256 of the canonical JSON of the LAST successfully-deployed
--   output schema. Compared against the fresh fingerprint on each
--   deploy to classify the diff (safe / unsafe).
-- ---------------------------------------------------------------------------

ALTER TABLE foundry_datasets
    ADD COLUMN IF NOT EXISTS last_output_schema_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_foundry_datasets_schema_fp
    ON foundry_datasets (last_output_schema_fingerprint)
    WHERE last_output_schema_fingerprint IS NOT NULL;
