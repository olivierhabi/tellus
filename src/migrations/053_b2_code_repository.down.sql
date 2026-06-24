-- ---------------------------------------------------------------------------
-- B2 — Code Repository Service DDL (DOWN).
--
-- Reverses 053_b2_code_repository.sql.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS code_repository_saga_ledger_init_failed_idx;
DROP INDEX IF EXISTS code_repository_saga_ledger_stemma_idx;
DROP INDEX IF EXISTS code_repository_saga_ledger_idem_uniq;
DROP TABLE IF EXISTS code_repository_saga_ledger CASCADE;

DROP INDEX IF EXISTS code_repository_branch_cache_protected_idx;
DROP TABLE IF EXISTS code_repository_branch_cache CASCADE;

DROP INDEX IF EXISTS code_repository_parent_folder_idx;
DROP INDEX IF EXISTS code_repository_parent_name_active_uniq;
DROP TABLE IF EXISTS code_repository CASCADE;
