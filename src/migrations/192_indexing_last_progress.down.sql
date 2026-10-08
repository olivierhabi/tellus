-- 192_indexing_last_progress.down.sql — reverse of 192_indexing_last_progress.sql.
DROP INDEX IF EXISTS idx_funnel_state_progress_watch;
ALTER TABLE funnel_state
  DROP COLUMN IF EXISTS last_progress_at;
