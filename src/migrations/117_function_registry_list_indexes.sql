-- Query support for the global Functions registry surface.
--
-- The first index makes the per-function LATERAL latest-version lookup an
-- index-only ordering operation. Trigram indexes keep case-insensitive
-- contains-search responsive without changing the user-visible search
-- semantics as the registry and Compass catalogs grow.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS function_registry_function_version_latest_idx
  ON function_registry_function_version(function_rid, created_at DESC, semver DESC, branch ASC);

CREATE INDEX IF NOT EXISTS function_registry_function_api_name_trgm_idx
  ON function_registry_function USING gin (api_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS function_registry_function_display_name_trgm_idx
  ON function_registry_function USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS code_repository_display_name_trgm_idx
  ON code_repository USING gin (display_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS projects_name_trgm_idx
  ON projects USING gin (name gin_trgm_ops);
