-- ---------------------------------------------------------------------------
-- B4 — Resource Imports persistence for Code Repositories.
--
-- One repository can import a set of (object_type, link_type) resources
-- from a single Ontology. The set is replace-all on PUT, with optimistic
-- concurrency via the content-derived ETag (computed by the route layer
-- as sha256 of the sorted (kind, api_name) tuples — no extra column).
--
-- Contracts:
--   B4-C-01  PK(repository_rid, kind, api_name) — kinda/apiname tuple is
--            unique within a repo. The same apiName can coexist as both
--            object_type and link_type (legal in OSDK).
--   B4-C-02  ontology_id is stored per row (not at the repo level) so a
--            future "multi-ontology import" doesn't require migration.
--            Today, route layer enforces "single ontology per repo".
--   B4-C-03  FK(repository_rid) → code_repository(rid) ON DELETE CASCADE.
--            When a repo is trashed/purged, its imports vanish.
--   B4-C-04  display_name + rid are snapshots taken at PUT time. They
--            inform the FE's offline render; the live values are fetched
--            via getObjectType / getLinkType on dialog reopen.
--   B4-C-05  added_by is the principal_user_id (UUID). Same source as the
--            B2 audit's principal_user_id column so we can join across.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS code_repository_resource_imports (
  repository_rid  TEXT NOT NULL,
  ontology_id     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('object_type','link_type')),
  api_name        TEXT NOT NULL CHECK (length(api_name) BETWEEN 1 AND 255),
  rid             TEXT,                                       -- snapshot at PUT
  display_name    TEXT,                                       -- snapshot at PUT
  added_by        UUID NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_rid, kind, api_name),
  CONSTRAINT code_repository_resource_imports_repo_fk
    FOREIGN KEY (repository_rid) REFERENCES code_repository(rid) ON DELETE CASCADE
);

-- Lookup: list imports for a repo, optionally narrowed to a kind.
CREATE INDEX IF NOT EXISTS code_repository_resource_imports_by_repo
  ON code_repository_resource_imports(repository_rid, kind);

-- Reverse lookup: which repos import a given ontology? (audit, cleanup)
CREATE INDEX IF NOT EXISTS code_repository_resource_imports_by_ontology
  ON code_repository_resource_imports(ontology_id);

COMMENT ON TABLE code_repository_resource_imports IS
  'B4 resource imports. PUT replaces the set atomically per (repository_rid). ETag is sha256 of sorted (kind, api_name) tuples — stateless.';
