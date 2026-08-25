-- ---------------------------------------------------------------------------
-- 154 — Storage-migration failure columns on link_type (truthfulness fix).
--
-- Pre-fix, linkStorageMigrator flipped storage_backend='iceberg' even when
-- the sidecar migration failed; the only failure signal was a NULL
-- migration_completed_at. These columns make failure a first-class,
-- inspectable state; storage_backend now only flips on confirmed success.
-- ---------------------------------------------------------------------------

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS migration_failed_at TIMESTAMPTZ;

ALTER TABLE link_type
    ADD COLUMN IF NOT EXISTS last_migration_error TEXT;
