-- ----------------------------------------------------------------------------
-- 139 — Function kind on the Functions Registry (Phase 2).
--
-- Edit-capability is a DECLARED contract recorded at publish time, never
-- inferred from function body content. The publish pipeline's AST walk
-- already extracts each function's declared signature; it now also derives
-- the function kind from the declared return type and stores it here, in
-- the same registry-version write.
--
-- Semantics:
--   NULL      — legacy/unclassified metadata (pre-139 rows, or versions
--               the backfill has not reached). The FE treats NULL as NOT
--               edit-capable (fail closed).
--   'edit'    — valid explicit edit declaration (return type resolves to
--               Edits.Object<T> imported from @osdk/functions).
--   'query'   — valid non-edit declared return type.
--   'unknown' — reserved for legacy artifacts the backfill attempted but
--               could not classify (missing/corrupt source, malformed
--               declaration). New publishes NEVER write NULL or 'unknown'.
-- ----------------------------------------------------------------------------

ALTER TABLE function_registry_function_version
  ADD COLUMN IF NOT EXISTS function_kind TEXT;

ALTER TABLE function_registry_function_version
  DROP CONSTRAINT IF EXISTS function_registry_function_version_kind_chk;

ALTER TABLE function_registry_function_version
  ADD CONSTRAINT function_registry_function_version_kind_chk
  CHECK (function_kind IN ('edit', 'query', 'unknown'));

COMMENT ON COLUMN function_registry_function_version.function_kind IS
  'Declared function kind from the publish-time AST walk: edit (Edits.Object<T> return), query (any other valid return type), unknown (unclassifiable legacy artifact). NULL = never analyzed.';

-- Backfill / picker scans: versions still needing classification.
CREATE INDEX IF NOT EXISTS function_registry_function_version_kind_null_idx
  ON function_registry_function_version(function_rid)
  WHERE function_kind IS NULL;
