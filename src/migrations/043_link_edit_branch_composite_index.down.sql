-- Down migration 043 — drop the (link_type_api_name, branch_id, executed_at DESC)
-- composite index. The migration 040 index (branch_id, link_type_api_name)
-- remains and covers administrative branch-scope scans.
BEGIN;
DROP INDEX IF EXISTS idx_link_edit_type_branch_time;
COMMIT;
