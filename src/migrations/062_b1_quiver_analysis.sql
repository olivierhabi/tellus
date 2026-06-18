-- Quiver B1 — quiver_analysis table.
-- Spec: tasks/quiver/quiver-tasks.md §B1 DDL.
-- Decisions: D-2026-05-04 D-05 (Postgres substitutes Cassandra),
--            D-2026-05-04 D-06 (ETag-CAS via "WHERE etag = $stale"),
--            D-2026-05-04 D-10 (UUIDv7 only — CHECK enforces v7 layout).

CREATE TABLE IF NOT EXISTS quiver_analysis (
  rid                 TEXT PRIMARY KEY
                        CHECK (rid ~ '^ri\.tellus-quiver\.main\.analysis\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  parent_folder_rid   TEXT NOT NULL,
  display_name        TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  description         TEXT CHECK (description IS NULL OR length(description) <= 2000),
  notebook_metadata   JSONB NOT NULL DEFAULT '{"defaultLoad":"VISIBLE","cardIdCounter":0,"branchRid":null}'::jsonb,
  cards               JSONB NOT NULL DEFAULT '{}'::jsonb,
  canvases            JSONB NOT NULL DEFAULT '[]'::jsonb,
  parameters          JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_version     BIGINT NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  etag                TEXT NOT NULL,
  document_blob_uri   TEXT,
  document_inline     JSONB,
  markings            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_deleted          BOOLEAN NOT NULL DEFAULT false,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          TEXT NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT NOT NULL,
  branch_rid          TEXT NOT NULL DEFAULT 'main',
  CHECK (
    (document_blob_uri IS NOT NULL AND document_inline IS NULL)
    OR (document_blob_uri IS NULL AND document_inline IS NOT NULL)
    OR (document_blob_uri IS NULL AND document_inline IS NULL)
  )
);

-- Look-ups by folder are common for the listAnalysesInFolder endpoint.
CREATE INDEX IF NOT EXISTS idx_quiver_analysis_by_folder
  ON quiver_analysis (parent_folder_rid, branch_rid)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_quiver_analysis_by_creator
  ON quiver_analysis (created_by)
  WHERE is_deleted = false;

-- Trash / soft-delete sweeper: rows with deleted_at older than 30 days
-- are eligible for hard-delete (Compass purge job).
CREATE INDEX IF NOT EXISTS idx_quiver_analysis_trash
  ON quiver_analysis (deleted_at)
  WHERE is_deleted = true;
