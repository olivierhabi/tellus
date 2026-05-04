-- Workshop B01 — workshop_module table.
-- Spec: tasks/workshop/workshop-tasks.md §B01 DDL.
-- Decision: D-2026-05-03 D-01 (sequential numbering 058+, not Flyway V101).

CREATE TABLE IF NOT EXISTS workshop_module (
  rid               TEXT PRIMARY KEY
                      CHECK (rid LIKE 'ri.workshop.main.module.%'),
  ontology_rid      TEXT NOT NULL,
  display_name      TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  description       TEXT CHECK (description IS NULL OR length(description) <= 2000),
  current_semver    TEXT NOT NULL DEFAULT '0.1.0',
  published_semver  TEXT,
  definition        JSONB NOT NULL,
  etag              TEXT NOT NULL,
  schema_version    INT  NOT NULL DEFAULT 4,
  parent_folder_rid TEXT NOT NULL,
  branch_rid        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        TEXT NOT NULL,
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workshop_module_ontology
  ON workshop_module(ontology_rid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workshop_module_folder
  ON workshop_module(parent_folder_rid)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workshop_module_branch
  ON workshop_module(branch_rid)
  WHERE branch_rid IS NOT NULL;

-- Display-name uniqueness within parent folder, case-insensitive,
-- excluding soft-deleted rows. Spec §B01 + decision D-07.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workshop_module_folder_name_ci
  ON workshop_module(parent_folder_rid, lower(display_name))
  WHERE deleted_at IS NULL;
