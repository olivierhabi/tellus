-- Connector types registry — master table for source types displayed in
-- the "Select source type" picker (/data-connection/new-source).
-- Each row represents a database backend the platform can connect to
-- (PostgreSQL, MySQL, etc.) along with metadata used by the frontend
-- to render the source card (title, icon, tags, wizard route).

CREATE TABLE IF NOT EXISTS connector_types (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  icon            TEXT NOT NULL DEFAULT 'database',
  icon_color      TEXT NOT NULL DEFAULT '#2B95D6',
  icon_src        TEXT,
  badge           TEXT CHECK (badge IN ('BETA', 'EXPERIMENTAL')),
  tags            TEXT[] NOT NULL DEFAULT '{}',
  href            TEXT,
  connector_type  TEXT NOT NULL,
  capabilities    JSONB NOT NULL DEFAULT '{"batchSync":true,"cdcSync":false,"tableExport":true,"useInCode":true}'::JSONB,
  sort_order      INT NOT NULL DEFAULT 0,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with the initial PostgreSQL connector type
INSERT INTO connector_types (id, title, icon, icon_color, icon_src, tags, href, connector_type, capabilities, sort_order)
VALUES (
  'postgresql-jdbc',
  'PostgreSQL (JDBC)',
  'database',
  '#2B95D6',
  '/brands/postgresql.svg',
  ARRAY['Batch syncs', 'CDC syncs', 'Table exports', 'Use in code'],
  '/data-connection/new-source/postgresql',
  'postgresql',
  '{"batchSync":true,"cdcSync":true,"tableExport":true,"useInCode":true}'::JSONB,
  10
) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS connector_types_by_sort
  ON connector_types (sort_order, title)
  WHERE enabled = TRUE;
