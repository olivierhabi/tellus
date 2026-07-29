-- ---------------------------------------------------------------------------
-- Migration 142: jemma_run_log retention support (Track 2 item #9).
--
-- The retention cleanup deletes log rows of TERMINAL runs whose
-- finished_at is older than the retention cutoff, in bounded
-- batches. The driving side of that query is
--
--   SELECT rid FROM jemma_run
--    WHERE state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
--      AND finished_at < $cutoff
--    ORDER BY finished_at
--    LIMIT $batch
--
-- — this partial index serves exactly that scan. The per-run log
-- lookup is already covered by 116's jemma_run_log(run_rid, id).
--
-- Additive only: a new index; no table rewrite; safe on existing
-- rows. CONCURRENTLY is not used because this project's migration
-- runner executes each file inside a transaction.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS jemma_run_terminal_finished_idx
  ON jemma_run(finished_at)
  WHERE state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT');
