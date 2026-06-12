-- 092 — group multiple per-table builds into one logical Foundry Build.
--
-- Foundry's orchestration model: a *Build* is a single execution that produces
-- MANY resources, exposed as `jobRids` (plural). Tellus dispatches one
-- `orchestration_builds` row per table import (each row is effectively a *Job*),
-- so a "Create sync for N tables" action produced N independent builds and the
-- job-tracker could only show one table at a time.
--
-- `group_rid` ties the per-table executions created by a single action into ONE
-- Build: every member carries the same `group_rid` (the lead member's rid), and
-- the read/SSE/cancel paths aggregate by `COALESCE(group_rid, rid)`. A solo
-- build is its own group of one, so single-table behaviour is unchanged.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and a
-- one-time backfill of legacy rows to `group_rid = rid`.

ALTER TABLE orchestration_builds
  ADD COLUMN IF NOT EXISTS group_rid TEXT;

CREATE INDEX IF NOT EXISTS orchestration_builds_group_rid_idx
  ON orchestration_builds (group_rid);

UPDATE orchestration_builds
   SET group_rid = rid
 WHERE group_rid IS NULL;
