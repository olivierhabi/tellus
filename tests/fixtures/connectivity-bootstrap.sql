-- ---------------------------------------------------------------------------
-- Test-only bootstrap: minimal pre-reqs for the B1 connectivity migrations.
--
-- Production runs `src/foundryMigrate.ts` which provisions users +
-- resources + dozens of other tables. For Testcontainers we only need:
--   - users (id PK)                  — created_by/updated_by FK target
--   - resources (rid PK, ...)        — compass_folder_rid FK target
--
-- The schemas mirror the production DDL fields the B1 code touches; FKs
-- to other tables (project_rid → resources, space_rid → resources) are
-- preserved because they're self-referential.
--
-- Loaded by tests/fixtures/containers.ts BEFORE any src/migrations/*.sql.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
  rid                  TEXT PRIMARY KEY
                       CHECK (rid ~ '^ri\.[a-z][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)?\.[a-z][a-z0-9-]*\..+$'),
  service              TEXT NOT NULL,
  type                 TEXT NOT NULL,
  display_name         TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  description          TEXT,
  documentation        TEXT,
  parent_folder_rid    TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
  project_rid          TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
  space_rid            TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
  trash_status         TEXT NOT NULL DEFAULT 'NOT_TRASHED'
                       CHECK (trash_status IN ('NOT_TRASHED','DIRECTLY_TRASHED','ANCESTOR_TRASHED')),
  created_by           UUID NOT NULL REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by           UUID NOT NULL REFERENCES users(id),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  etag                 BIGINT NOT NULL DEFAULT 1,
  metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
  legacy_uuid          UUID UNIQUE
);

CREATE INDEX IF NOT EXISTS resources_parent_idx  ON resources (parent_folder_rid);
CREATE INDEX IF NOT EXISTS resources_project_idx ON resources (project_rid);
CREATE INDEX IF NOT EXISTS resources_space_idx   ON resources (space_rid);
CREATE INDEX IF NOT EXISTS resources_type_idx    ON resources (type);

-- ETag bump trigger (matches foundryMigrate.ts behaviour).
CREATE OR REPLACE FUNCTION resources_bump_etag() RETURNS trigger AS $$
BEGIN
  NEW.etag := COALESCE(OLD.etag, 0) + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS resources_bump_etag_t ON resources;
CREATE TRIGGER resources_bump_etag_t BEFORE UPDATE ON resources
FOR EACH ROW EXECUTE FUNCTION resources_bump_etag();

-- Required by the Compass connection bootstrap: a root space + a folder.
-- Seeded by containers.ts after bootstrap runs; included here for clarity
-- of the dependency surface (NOT executed by this file itself).
--
-- INSERT INTO users (id, email) VALUES ('00000000-...-...', 'test@tellus.local');
-- INSERT INTO resources (rid, service, type, display_name, space_rid, created_by, updated_by)
--   VALUES ('ri.compass.main.space.test', 'compass', 'space', 'Test Space',
--           'ri.compass.main.space.test', '00000000-...-...', '00000000-...-...');

-- Idempotency-Keys table is created by an earlier production migration; the
-- bootstrap reproduces the minimum shape src/middleware/idempotencyKey.ts uses.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            UUID NOT NULL,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  response_body  JSONB NOT NULL,
  response_etag  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',
  PRIMARY KEY (key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_by_endpoint
  ON idempotency_keys (endpoint, expires_at);
