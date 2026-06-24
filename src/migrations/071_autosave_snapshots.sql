-- ---------------------------------------------------------------------------
-- 071_autosave_snapshots.sql
-- Foundry-faithful resource history.
--
-- Each row captures the post-mutation state of a Compass-registered
-- resource. Capture is performed at the application layer (not via DB
-- triggers) so the writer can record the actor, the synthesized
-- change_summary, and the full payload needed to restore the resource
-- without joining back into the source-of-truth tables.
--
-- Lifecycle:
--   * Capture is synchronous inside the same transaction as the mutation
--     (autosaveService.captureSnapshot in src/services/autosaveService.ts).
--   * Retention is enforced by the autosave-retention cron — see
--     retention_until + scripts/jobs/autosaveRetention.ts (follow-up PR).
--
-- Indexing strategy:
--   * idx_autosave_snapshots_project — list-by-project (project page UI)
--   * idx_autosave_snapshots_rid     — list-by-resource (per-resource history)
--   * idx_autosave_snapshots_actor   — audit query: "show me everything I changed"
--   * idx_autosave_snapshots_retention — drives the retention cron's WHERE clause
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS autosave_snapshots (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_rid    TEXT        NOT NULL,
  resource_kind   TEXT        NOT NULL CHECK (
    resource_kind IN (
      'dataset', 'pipeline', 'workshop-module', 'code-repository',
      'folder', 'project'
    )
  ),
  project_id      UUID        NOT NULL,
  parent_folder_rid TEXT      NULL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id        UUID        NULL,
  actor_email     TEXT        NULL,                 -- denormalized for display
  change_kind     TEXT        NOT NULL CHECK (
    change_kind IN (
      'created', 'renamed', 'moved', 'schema-changed', 'content-changed',
      'published', 'archived', 'unarchived', 'deleted', 'restored',
      'configuration-changed'
    )
  ),
  change_summary  TEXT        NOT NULL CHECK (char_length(change_summary) BETWEEN 1 AND 256),
  payload         JSONB       NOT NULL,             -- full restore payload
  parent_snapshot_id UUID     NULL REFERENCES autosave_snapshots(id) ON DELETE SET NULL,
  retention_until TIMESTAMPTZ NULL,                 -- NULL = keep forever (admin-pinned)
  CONSTRAINT autosave_snapshots_payload_size_check
    CHECK (octet_length(payload::text) < 1048576)   -- 1 MB hard cap per snapshot
);

-- Project-scoped list (powers the /projects/:id/autosaved page).
CREATE INDEX IF NOT EXISTS idx_autosave_snapshots_project
  ON autosave_snapshots (project_id, snapshot_at DESC, id DESC);

-- Per-resource history (powers the right-panel timeline on resource pages).
CREATE INDEX IF NOT EXISTS idx_autosave_snapshots_rid
  ON autosave_snapshots (resource_rid, snapshot_at DESC);

-- Per-actor audit query.
CREATE INDEX IF NOT EXISTS idx_autosave_snapshots_actor
  ON autosave_snapshots (actor_id, snapshot_at DESC)
  WHERE actor_id IS NOT NULL;

-- Retention cron predicate.
CREATE INDEX IF NOT EXISTS idx_autosave_snapshots_retention
  ON autosave_snapshots (retention_until)
  WHERE retention_until IS NOT NULL;

COMMENT ON TABLE autosave_snapshots IS
  'Foundry-faithful resource history. Per-mutation snapshots captured by autosaveService.';
COMMENT ON COLUMN autosave_snapshots.payload IS
  'Full state needed to restore the resource. Schema is per resource_kind (see autosaveService).';
COMMENT ON COLUMN autosave_snapshots.retention_until IS
  'NULL keeps forever (admin-pinned). Otherwise the retention cron removes the row after this timestamp.';
