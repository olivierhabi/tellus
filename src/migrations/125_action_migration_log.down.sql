-- ---------------------------------------------------------------------------
-- Migration 125 (down) — drop the action migration log ledger.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_action_migration_log_actor;
DROP INDEX IF EXISTS idx_action_migration_log_action;
DROP TABLE IF EXISTS action_migration_log;
