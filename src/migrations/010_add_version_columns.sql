-- ---------------------------------------------------------------------------
-- 010_add_version_columns.sql
-- ---------------------------------------------------------------------------
-- Ontology Platform spec §2.3 "Optimistic Concurrency":
-- every mutable resource exposes an ETag + If-Match contract. These columns
-- back the ETag header with a monotonically increasing integer per row.
--
-- Each UPDATE to a tracked row must SET version = version + 1. The route
-- handler compares the incoming If-Match value to the current version and
-- returns 409 CONCURRENT_EDIT_CONFLICT on mismatch.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS object_type
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE IF EXISTS property
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE IF EXISTS link_type
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE IF EXISTS interface_type
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE IF EXISTS action_type
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Triggers that auto-increment `version` on UPDATE. The service layer can
-- still supply an explicit version for debugging, but the DB guarantees
-- monotonic growth even if a hand-written UPDATE forgets to bump it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION bump_version_column() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('object_type') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_object_type_version ON object_type';
    EXECUTE 'CREATE TRIGGER trg_object_type_version BEFORE UPDATE ON object_type FOR EACH ROW EXECUTE FUNCTION bump_version_column()';
  END IF;
  IF to_regclass('property') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_property_version ON property';
    EXECUTE 'CREATE TRIGGER trg_property_version BEFORE UPDATE ON property FOR EACH ROW EXECUTE FUNCTION bump_version_column()';
  END IF;
  IF to_regclass('link_type') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_link_type_version ON link_type';
    EXECUTE 'CREATE TRIGGER trg_link_type_version BEFORE UPDATE ON link_type FOR EACH ROW EXECUTE FUNCTION bump_version_column()';
  END IF;
  IF to_regclass('interface_type') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_interface_type_version ON interface_type';
    EXECUTE 'CREATE TRIGGER trg_interface_type_version BEFORE UPDATE ON interface_type FOR EACH ROW EXECUTE FUNCTION bump_version_column()';
  END IF;
  IF to_regclass('action_type') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_action_type_version ON action_type';
    EXECUTE 'CREATE TRIGGER trg_action_type_version BEFORE UPDATE ON action_type FOR EACH ROW EXECUTE FUNCTION bump_version_column()';
  END IF;
END;
$$;
