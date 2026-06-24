-- Quiver B4 — quiver_working_state table (24 h TTL).
-- Spec: tasks/quiver/quiver-tasks.md §B4 DDL.
-- D-05 (Postgres): no native row TTL — use expires_at + sweeper function.

CREATE TABLE IF NOT EXISTS quiver_working_state (
  rid                 TEXT NOT NULL,
  state_id            TEXT NOT NULL CHECK (state_id ~ '^[a-z0-9]{10}$'),
  user_subject        TEXT NOT NULL,
  document_inline     JSONB,
  document_blob_uri   TEXT,
  from_version        BIGINT,
  branch_rid          TEXT NOT NULL DEFAULT 'main',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  PRIMARY KEY (rid, state_id),
  CHECK (
    (document_blob_uri IS NOT NULL AND document_inline IS NULL)
    OR (document_blob_uri IS NULL AND document_inline IS NOT NULL)
  )
);

-- Sweeper queries by expires_at; partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_quiver_working_state_expires
  ON quiver_working_state (expires_at);

-- Per-user lookups for the FE "your working states" UI.
CREATE INDEX IF NOT EXISTS idx_quiver_working_state_by_user
  ON quiver_working_state (user_subject, rid);

COMMENT ON TABLE quiver_working_state IS
  'B4 — ephemeral per-user-per-analysis edits. 24h TTL via expires_at column.';

-- Sweeper function — invoked by an external cron / health-check job.
CREATE OR REPLACE FUNCTION quiver_purge_expired_working_states()
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM quiver_working_state WHERE expires_at < now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION quiver_purge_expired_working_states() IS
  'B4 C-10 — purges working states past their 24h TTL. Returns row count for metric emission.';
