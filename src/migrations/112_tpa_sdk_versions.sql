-- ---------------------------------------------------------------------------
-- Migration 112: Developer Console OSDK version metadata
--
-- Foundry Developer Console tracks generated Ontology SDK package versions
-- per third-party application. Full npm/codegen artifacts are out of band;
-- this table is the product-facing version history used by the UI.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tpa_sdk_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('generating', 'ready', 'failed', 'deprecated')),
  package_name    TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (application_id, version)
);

CREATE INDEX IF NOT EXISTS idx_tpa_sdk_versions_app
  ON tpa_sdk_versions (application_id, created_at DESC);

COMMENT ON TABLE tpa_sdk_versions IS
  'Ontology SDK package versions registered for a third-party application.';
