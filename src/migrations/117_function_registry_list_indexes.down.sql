DROP INDEX IF EXISTS projects_name_trgm_idx;
DROP INDEX IF EXISTS code_repository_display_name_trgm_idx;
DROP INDEX IF EXISTS function_registry_function_display_name_trgm_idx;
DROP INDEX IF EXISTS function_registry_function_api_name_trgm_idx;
DROP INDEX IF EXISTS function_registry_function_version_latest_idx;

-- pg_trgm may be shared by other product surfaces, so rollback intentionally
-- leaves the extension installed.
