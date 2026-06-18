-- Migration 056 — B3 Templates Engine.
--
-- Owned data: templates_index caches manifest metadata for listing.
-- Template content itself is shipped as TS literals in the service binary
-- (see src/services/templates/manifest.ts). The DB caches only what's needed
-- for fast listing + admin operations (deprecation flips).

CREATE TABLE templates_index (
  template_id     TEXT NOT NULL,
  version         TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  language        TEXT NOT NULL CHECK (language IN ('typescript','python','java','sql')),
  category        TEXT NOT NULL CHECK (category IN ('functions','transforms')),
  description     TEXT NOT NULL DEFAULT '',
  parameters_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_count      INT NOT NULL CHECK (file_count >= 1),
  total_bytes     BIGINT NOT NULL CHECK (total_bytes >= 0),
  is_deprecated   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deprecated_at   TIMESTAMPTZ,
  CONSTRAINT templates_index_pk PRIMARY KEY (template_id, version),
  CONSTRAINT templates_index_dep_chk CHECK ((is_deprecated = FALSE AND deprecated_at IS NULL) OR (is_deprecated = TRUE AND deprecated_at IS NOT NULL))
);

CREATE INDEX templates_index_category_lang ON templates_index (category, language);
