-- 121_transform_incremental_state.down.sql
-- Down migration for Phase 4 incremental-state table.

DROP TABLE IF EXISTS transform_incremental_state;
-- The set_updated_at() function is shared with other tables — leave it.
