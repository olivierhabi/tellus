-- ---------------------------------------------------------------------------
-- Migration 111: Developer Console third-party applications (Palantir 3PA)
--
-- Foundry Developer Console registers applications as resources with RID:
--   ri.third-party-applications.main.application.<uuid>
-- each backed by an OAuth client (Keycloak in Tellus). Product metadata
-- (ontology resources, platform scopes, project grants, favorites) lives
-- here; client secrets never leave Keycloak except on create/rotate.
--
-- Migration 114 removes this migration's historical capture-only seed.
-- New deployments must use an explicit development/test seed command.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS third_party_applications (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rid                       TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  description               TEXT NOT NULL DEFAULT '',
  client_id                 TEXT NOT NULL UNIQUE,
  client_type               TEXT NOT NULL CHECK (client_type IN ('public', 'confidential')),
  keycloak_client_uuid      TEXT,
  organization_name         TEXT NOT NULL DEFAULT 'bihire',
  organization_id           TEXT,
  location_path             TEXT NOT NULL DEFAULT '',
  project_name              TEXT NOT NULL DEFAULT '',
  project_rid               TEXT,
  creator_id                TEXT NOT NULL DEFAULT 'system',
  creator_name              TEXT NOT NULL DEFAULT 'system',
  last_edited_by            TEXT NOT NULL DEFAULT 'system',
  last_modified_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_count        INT NOT NULL DEFAULT 1,
  logo_url                  TEXT,
  resource_restrictions     TEXT NOT NULL DEFAULT 'restricted'
                              CHECK (resource_restrictions IN ('restricted', 'unrestricted')),
  operation_restrictions    TEXT NOT NULL DEFAULT 'restricted'
                              CHECK (operation_restrictions IN ('restricted', 'unrestricted')),
  marking_restrictions      TEXT NOT NULL DEFAULT 'unrestricted'
                              CHECK (marking_restrictions IN ('restricted', 'unrestricted')),
  permission_mode           TEXT NOT NULL DEFAULT 'user'
                              CHECK (permission_mode IN ('user', 'application')),
  application_types         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  grant_types               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ
);

COMMENT ON TABLE third_party_applications IS
  'Foundry Developer Console applications (third-party / OSDK apps). RID prefix ri.third-party-applications.main.application.';
COMMENT ON COLUMN third_party_applications.keycloak_client_uuid IS
  'Keycloak client internal UUID; null for pure-seed rows without a live KC client.';

CREATE INDEX IF NOT EXISTS idx_tpa_creator
  ON third_party_applications (creator_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tpa_last_modified
  ON third_party_applications (last_modified_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tpa_name_trgm_like
  ON third_party_applications (lower(name));

CREATE TABLE IF NOT EXISTS tpa_favorites (
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);

CREATE TABLE IF NOT EXISTS tpa_redirect_uris (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  uri             TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, uri)
);

CREATE TABLE IF NOT EXISTS tpa_operation_scopes (
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (application_id, scope)
);

CREATE TABLE IF NOT EXISTS tpa_ontology_resources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('object_type', 'action_type', 'function')),
  api_name        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  icon_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'experimental',
  parent_api_name TEXT,
  has_no_resources BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INT NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (application_id, kind, api_name)
);

CREATE INDEX IF NOT EXISTS idx_tpa_ontology_resources_app
  ON tpa_ontology_resources (application_id, kind, sort_order);

CREATE TABLE IF NOT EXISTS tpa_project_grants (
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  project_name    TEXT NOT NULL,
  project_rid     TEXT,
  description     TEXT NOT NULL DEFAULT '',
  icon_class      TEXT NOT NULL DEFAULT 'resource-icon__project__mypxcb',
  href            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, project_id)
);

-- ---------------------------------------------------------------------------
-- Seed: capture-parity demo application (test01 / RID 3656c139-…)
-- ---------------------------------------------------------------------------
INSERT INTO third_party_applications (
  id,
  rid,
  name,
  description,
  client_id,
  client_type,
  organization_name,
  location_path,
  project_name,
  project_rid,
  creator_id,
  creator_name,
  last_edited_by,
  last_modified_at,
  organization_count,
  resource_restrictions,
  operation_restrictions,
  marking_restrictions,
  permission_mode,
  application_types,
  grant_types
) VALUES (
  '3656c139-3fcc-400e-a962-6057512ee536',
  'ri.third-party-applications.main.application.3656c139-3fcc-400e-a962-6057512ee536',
  'test01',
  '',
  '70d27f7320a5204cfbdae1b2b418ed52',
  'confidential',
  'bihire',
  '/bihire-6e08c8/Hello world',
  'Hello world',
  'ri.compass.main.folder.967806cc-581e-4345-a362-d42d8672cf4b',
  'seed-icyimpaye',
  'icyimpaye ellysa',
  'icyimpaye ellysa',
  '2026-07-14T12:00:00.000Z',
  1,
  'restricted',
  'restricted',
  'unrestricted',
  'user',
  ARRAY['client-facing', 'backend-service']::TEXT[],
  ARRAY['authorization_code']::TEXT[]
) ON CONFLICT (id) DO NOTHING;

-- Ontology SDK resources (from OntologySdkPage OBJECT_TYPES / ACTION_TYPES)
INSERT INTO tpa_ontology_resources (
  application_id, kind, api_name, display_name, icon_json, status, parent_api_name, has_no_resources, sort_order, metadata
) VALUES
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'object_type',
  'ExampleExplainer',
  '[Example] Explainer',
  '{"icon":"help","color":"#BD6BBD","bg":"rgb(249, 241, 249)","border":"rgb(231, 202, 231)"}'::jsonb,
  'documented',
  NULL,
  FALSE,
  10,
  '{"actionApiName":"add-one-state-callout63bf71f1-1337-4730-ab85-576c4b361534"}'::jsonb
),
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'object_type',
  'ExampleRouteAlert',
  '[Example] Route Alert',
  '{"icon":"warning-sign","color":"#13C9BA","bg":"rgb(236, 253, 252)","border":"rgb(185, 248, 243)"}'::jsonb,
  'documented',
  NULL,
  FALSE,
  20,
  '{"actionApiName":"one-state-route-alert-update-statusc36ffe76-39ed-4daa-97b7-d04641f838c3"}'::jsonb
),
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'object_type',
  'ExampleLogUpdateRouteAlertStatus',
  '[Example][Log] Update Route Alert Status',
  '{"icon":"history","color":"#5F6B7C","bg":"rgb(243, 245, 246)","border":"rgb(212, 216, 222)"}'::jsonb,
  'documented',
  NULL,
  FALSE,
  30,
  '{"actionApiName":"one-state-route-alert-update-statusc36ffe76-39ed-4daa-97b7-d04641f838c3"}'::jsonb
),
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'object_type',
  'OlivierOrder',
  '[Olivier] Order',
  '{"icon":"cube","color":"#4C90F0","bg":"rgb(236, 243, 253)","border":"rgb(184, 211, 249)"}'::jsonb,
  'experimental',
  NULL,
  TRUE,
  40,
  '{}'::jsonb
),
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'action_type',
  'one-state-route-alert-update-statusc36ffe76-39ed-4daa-97b7-d04641f838c3',
  '[Example] Update Route Alert Status',
  '{"icon":"edit","color":"#FFFFFF","bg":"rgb(17, 20, 24)","border":"rgb(14, 17, 20)"}'::jsonb,
  'experimental',
  NULL,
  FALSE,
  10,
  '{}'::jsonb
),
(
  '3656c139-3fcc-400e-a962-6057512ee536',
  'action_type',
  'add-one-state-callout63bf71f1-1337-4730-ab85-576c4b361534',
  'Add One State Callout',
  '{"icon":"new-object","color":"#FFFFFF","bg":"rgb(17, 20, 24)","border":"rgb(14, 17, 20)"}'::jsonb,
  'experimental',
  NULL,
  FALSE,
  20,
  '{}'::jsonb
)
ON CONFLICT (application_id, kind, api_name) DO NOTHING;

-- Default platform scopes for the seed app (common OSDK starter set)
INSERT INTO tpa_operation_scopes (application_id, scope, enabled) VALUES
  ('3656c139-3fcc-400e-a962-6057512ee536', 'api:use-ontologies-read', TRUE),
  ('3656c139-3fcc-400e-a962-6057512ee536', 'api:use-ontologies-write', FALSE),
  ('3656c139-3fcc-400e-a962-6057512ee536', 'api:use-datasets-read', FALSE),
  ('3656c139-3fcc-400e-a962-6057512ee536', 'api:use-admin-read', FALSE)
ON CONFLICT (application_id, scope) DO NOTHING;

-- Hello world project grant (matches SelectProjectsDialog default)
INSERT INTO tpa_project_grants (
  application_id, project_id, project_name, project_rid, description, icon_class, href
) VALUES (
  '3656c139-3fcc-400e-a962-6057512ee536',
  'hello-world',
  'Hello world',
  'ri.compass.main.folder.967806cc-581e-4345-a362-d42d8672cf4b',
  'Learn about the platform',
  'resource-icon__project__mypxcb',
  NULL
) ON CONFLICT (application_id, project_id) DO NOTHING;
