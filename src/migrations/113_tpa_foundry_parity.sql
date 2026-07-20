-- ---------------------------------------------------------------------------
-- Migration 113: Developer Console Foundry-complete depth
-- - interface resources on OSDK resource set
-- - metrics time-series for Analytics
-- - SDK package payload storage (generated package.json + index.ts)
-- - service-user resource shares (Sharing & tokens)
-- ---------------------------------------------------------------------------

-- Allow interface kind on ontology resources
ALTER TABLE tpa_ontology_resources DROP CONSTRAINT IF EXISTS tpa_ontology_resources_kind_check;
ALTER TABLE tpa_ontology_resources
  ADD CONSTRAINT tpa_ontology_resources_kind_check
  CHECK (kind IN ('object_type', 'action_type', 'function', 'interface'));

-- SDK package bodies (codegen output metadata + files)
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS package_files JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS resource_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS ontology_id TEXT;

COMMENT ON COLUMN tpa_sdk_versions.package_files IS
  'Generated package files map path -> content (package.json, src/index.ts, …).';
COMMENT ON COLUMN tpa_sdk_versions.resource_snapshot IS
  'Ontology resources frozen into this SDK version.';

-- Metrics series (request telemetry for Analytics empty/chart states)
CREATE TABLE IF NOT EXISTS tpa_metrics_points (
  id              BIGSERIAL PRIMARY KEY,
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  metric          TEXT NOT NULL DEFAULT 'requests'
                    CHECK (metric IN ('requests', 'errors', 'latency_ms')),
  value           DOUBLE PRECISION NOT NULL DEFAULT 1,
  dimensions      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_tpa_metrics_app_ts
  ON tpa_metrics_points (application_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_tpa_metrics_app_metric_ts
  ON tpa_metrics_points (application_id, metric, ts DESC);

-- Service-user shares (Sharing & tokens)
CREATE TABLE IF NOT EXISTS tpa_service_shares (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  resource_kind   TEXT NOT NULL
                    CHECK (resource_kind IN (
                      'object_type', 'action_type', 'function', 'interface',
                      'project', 'dataset', 'ontology'
                    )),
  resource_id     TEXT NOT NULL,
  resource_name   TEXT NOT NULL DEFAULT '',
  access_level    TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (access_level IN ('viewer', 'editor', 'owner')),
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, resource_kind, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_tpa_service_shares_app
  ON tpa_service_shares (application_id, resource_kind);

-- List scale: index on soft-deleted apps already exists; add client_id lookup
CREATE INDEX IF NOT EXISTS idx_tpa_client_id
  ON third_party_applications (client_id) WHERE deleted_at IS NULL;
