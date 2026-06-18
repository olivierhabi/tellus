-- ===========================================================================
-- Reverse migration 046 — T-05 Phase B rollback.
--
-- Drops the columns and indexes added by 046. Safe to run as long as no
-- live worker is still writing to them (the route's INSERT references the
-- columns optionally — see src/routes/exports.ts — but production DBA
-- should pause the worker before reversing).
-- ===========================================================================

DROP INDEX IF EXISTS idx_export_job_requested_by;
DROP INDEX IF EXISTS idx_export_job_status_created;

ALTER TABLE export_job
  DROP COLUMN IF EXISTS download_url_expires_at;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS failure_reason;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS failed_at;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS completed_at;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS started_at;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS branch_id_snapshot;
ALTER TABLE export_job
  DROP COLUMN IF EXISTS security_context_snapshot;
