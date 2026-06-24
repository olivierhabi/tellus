-- ===========================================================================
-- Migration 046 — T-05 Phase B: capture security context + lifecycle
--                  timestamps + retention metadata on export_job rows.
--
-- Closes B-5: at job-creation the route now persists buildSecurityFilter()
-- and readBranchHeader() so the worker (which may run after the requester's
-- session has expired) executes against the original principal's context.
--
-- Additive only — no renames, no constraint tightening on existing columns,
-- no destructive ops. See `046_export_job_security_snapshot.down.sql` for
-- the reverse path.
-- ===========================================================================

-- 1. Security context + branch snapshot. NOT NULL with default so existing
--    rows (created before this migration) get an empty snapshot rather
--    than blocking the migration on them.
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS security_context_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS branch_id_snapshot TEXT NULL;

-- 2. Lifecycle timestamps. Each phase records its transition time so the
--    Prometheus duration histogram has a real `completed_at - started_at`
--    measurement (and not just `now() - created_at`, which inflates the
--    p99 with queue time).
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS started_at      TIMESTAMPTZ NULL;
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS completed_at    TIMESTAMPTZ NULL;
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS failed_at       TIMESTAMPTZ NULL;
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS failure_reason  TEXT NULL;

-- 3. Download URL TTL. The original schema has a generic `expires_at` for
--    the row; the spec requires a separate field for the *signed URL*'s
--    TTL so a job that completes can still be inspected via GET after the
--    URL has expired (we serve EXPORT_DOWNLOAD_EXPIRED 410 in that case
--    instead of 404).
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS download_url_expires_at TIMESTAMPTZ NULL;

-- 4. Indexes for the worker's claim-loop and the user's list view.
--    Partial index on (status, created_at) keeps the hot index small —
--    only PENDING+RUNNING rows ever live there. The (requested_by,
--    created_at DESC) index serves /api/v1/ontology/:id/exports list
--    page in O(log n).
CREATE INDEX IF NOT EXISTS idx_export_job_status_created
  ON export_job (status, created_at)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_export_job_requested_by
  ON export_job (requested_by, created_at DESC);
