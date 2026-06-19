-- Down for 092 — drop the build-group column + index.
DROP INDEX IF EXISTS orchestration_builds_group_rid_idx;
ALTER TABLE orchestration_builds DROP COLUMN IF EXISTS group_rid;
