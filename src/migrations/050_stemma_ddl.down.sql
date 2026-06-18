-- ===========================================================================
-- 031_stemma_ddl.down.sql — reverses 031_stemma_ddl.sql
--
-- DoD requires reversible migrations. Drops in dependency order.
-- ===========================================================================

BEGIN;

DROP INDEX IF EXISTS code_repos_idempotency_expires_idx;
DROP TABLE IF EXISTS code_repos_idempotency;

DROP INDEX IF EXISTS stemma_quarantine_expires_idx;
DROP TABLE IF EXISTS stemma_quarantine;

DROP TABLE IF EXISTS stemma_blob;

DROP TABLE IF EXISTS stemma_loose_object;

DROP INDEX IF EXISTS stemma_packfile_repo_idx;
DROP TABLE IF EXISTS stemma_packfile;

DROP INDEX IF EXISTS stemma_ref_repo_idx;
DROP TABLE IF EXISTS stemma_ref;

DROP TABLE IF EXISTS stemma_repository;

COMMIT;
