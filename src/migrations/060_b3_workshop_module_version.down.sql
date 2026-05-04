-- Reverse of 060_b3_workshop_module_version.sql.
ALTER TABLE workshop_module DROP COLUMN IF EXISTS published_at;
ALTER TABLE workshop_module DROP COLUMN IF EXISTS published_semver;
DROP INDEX IF EXISTS idx_workshop_module_version_semver;
DROP INDEX IF EXISTS idx_workshop_module_version_rid;
DROP TABLE IF EXISTS workshop_module_version;
