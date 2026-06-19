-- B1 — connectivity.connections
-- Tellus PostgreSQL Connectivity spec v2 §35–88
--
-- Connection resource: customer-defined data source (PostgreSQL, etc.).
-- Owned by a Compass folder (compass_folder_rid). Versioned for ETag/If-Match.
-- Soft-deleted (deleted_at IS NOT NULL excludes from list, returns 404 on read).

CREATE TABLE IF NOT EXISTS connectivity_connections (
  rid                     TEXT PRIMARY KEY,
  tenant                  TEXT NOT NULL,
  name                    TEXT NOT NULL,
  description             TEXT,
  connector_type          TEXT NOT NULL CHECK (connector_type IN ('postgresql')),
  worker_type             TEXT NOT NULL CHECK (worker_type IN ('foundryWorker', 'agentProxy')),
  agent_group_rid         TEXT,
  config                  JSONB NOT NULL,
  egress_policy           JSONB NOT NULL DEFAULT '{"allowlist":[]}'::JSONB,
  compass_folder_rid      TEXT NOT NULL,
  status                  JSONB NOT NULL DEFAULT '{"state":"UNKNOWN","lastCheckedAt":null}'::JSONB,
  version                 BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              TEXT NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              TEXT NOT NULL,
  deleted_at              TIMESTAMPTZ,
  deleted_by              TEXT,
  CONSTRAINT connectivity_connections_rid_format
    CHECK (rid ~ '^ri\.magritte\.main\.source\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT connectivity_connections_agent_group_required_when_agent_proxy
    CHECK (worker_type <> 'agentProxy' OR agent_group_rid IS NOT NULL)
);

-- FK to Compass resources. ON DELETE RESTRICT enforces B1 acceptance
-- criterion 5 ("folder deletion blocked while connection exists") at the
-- DB layer: PostgreSQL rejects DELETE on the folder row while any
-- non-deleted connection row references it. The migration runner tracks
-- applied migrations, so this runs at most once; we don't need a DO-block
-- guard against duplicate constraint name.
ALTER TABLE connectivity_connections
  ADD CONSTRAINT connectivity_connections_folder_fk
  FOREIGN KEY (compass_folder_rid) REFERENCES resources(rid) ON DELETE RESTRICT;

-- Unique name within a folder, excluding soft-deleted rows.
CREATE UNIQUE INDEX IF NOT EXISTS connectivity_connections_unique_name_in_folder
  ON connectivity_connections (compass_folder_rid, name)
  WHERE deleted_at IS NULL;

-- List queries: by tenant, by folder, both with deleted_at filter.
CREATE INDEX IF NOT EXISTS connectivity_connections_by_tenant
  ON connectivity_connections (tenant, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS connectivity_connections_by_folder
  ON connectivity_connections (compass_folder_rid, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS connectivity_connections_by_connector
  ON connectivity_connections (connector_type)
  WHERE deleted_at IS NULL;

-- Audit table for status transitions surfaced by /status endpoint history.
CREATE TABLE IF NOT EXISTS connectivity_connection_status_log (
  id                      BIGSERIAL PRIMARY KEY,
  connection_rid          TEXT NOT NULL REFERENCES connectivity_connections(rid) ON DELETE CASCADE,
  state                   TEXT NOT NULL,
  checked_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  details                 JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS connectivity_connection_status_log_by_rid
  ON connectivity_connection_status_log (connection_rid, checked_at DESC);
