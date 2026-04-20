-- ---------------------------------------------------------------------------
-- Task PB-B8 follow-bd-migrate — add foundry_dataset_id column.
--
-- `backing_datasource.dataset_id` FKs to the legacy `dataset` table
-- (pre-Foundry ontology-engine schema). The Pipeline Builder writes
-- outputs into `foundry_datasets` which is a separate table. To let the
-- PB-B8 lineage auto-fire resolve by a proper FK instead of the
-- dual-match on `file_path`, we add a nullable `foundry_dataset_id`
-- column that references foundry_datasets(id). Legacy `dataset_id`
-- stays in place so nothing breaks; findObjectTypesFor prefers the new
-- column when populated.
-- ---------------------------------------------------------------------------

ALTER TABLE backing_datasource
    ADD COLUMN IF NOT EXISTS foundry_dataset_id UUID
    REFERENCES foundry_datasets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_backing_datasource_foundry_dataset
    ON backing_datasource (foundry_dataset_id)
    WHERE foundry_dataset_id IS NOT NULL;
