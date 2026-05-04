-- Quiver B4 — quiver_analysis_version table.
-- Spec: tasks/quiver/quiver-tasks.md §B4 DDL.
-- Decisions: D-2026-05-04 D-05 (Postgres substitutes Cassandra),
--            D-2026-05-04 D-06 (ETag-CAS for concurrent saves).

CREATE TABLE IF NOT EXISTS quiver_analysis_version (
  rid                 TEXT NOT NULL,
  version             BIGINT NOT NULL CHECK (version >= 1),
  document_inline     JSONB,
  document_blob_uri   TEXT,
  parent_version      BIGINT,
  saved_by            TEXT NOT NULL,
  saved_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  message             TEXT CHECK (message IS NULL OR length(message) <= 2000),
  is_named_save       BOOLEAN NOT NULL DEFAULT FALSE,
  branch_rid          TEXT NOT NULL DEFAULT 'main',
  cards_count         INT NOT NULL DEFAULT 0,
  PRIMARY KEY (rid, version),
  CHECK (
    (document_blob_uri IS NOT NULL AND document_inline IS NULL)
    OR (document_blob_uri IS NULL AND document_inline IS NOT NULL)
  )
);

-- Listing UI paginates DESC by version (B4 C-04).
CREATE INDEX IF NOT EXISTS idx_quiver_version_list
  ON quiver_analysis_version (rid, version DESC);

-- Named-save filter for the default UI list (B4 C-02).
CREATE INDEX IF NOT EXISTS idx_quiver_version_named
  ON quiver_analysis_version (rid, version DESC)
  WHERE is_named_save = TRUE;

COMMENT ON TABLE quiver_analysis_version IS
  'B4 — immutable per-analysis snapshots. version is monotonic per (rid, branch_rid).';
