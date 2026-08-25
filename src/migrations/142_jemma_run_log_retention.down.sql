-- Migration 142 down: drop the retention-support index.
DROP INDEX IF EXISTS jemma_run_terminal_finished_idx;
