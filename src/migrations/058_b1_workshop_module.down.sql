-- Reversal of 058_b1_workshop_module.sql.
DROP INDEX IF EXISTS uq_workshop_module_folder_name_ci;
DROP INDEX IF EXISTS idx_workshop_module_branch;
DROP INDEX IF EXISTS idx_workshop_module_folder;
DROP INDEX IF EXISTS idx_workshop_module_ontology;
DROP TABLE IF EXISTS workshop_module;
