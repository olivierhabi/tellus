ALTER TABLE link_type DROP COLUMN IF EXISTS migration_failed_at;
ALTER TABLE link_type DROP COLUMN IF EXISTS last_migration_error;
