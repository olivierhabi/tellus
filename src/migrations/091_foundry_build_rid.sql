-- 091 — allow Foundry-native build RIDs on orchestration_builds.
--
-- Builds are now minted in the Foundry resource namespace
-- (`ri.foundry.main.build.*`) to match the platform's resource model and the
-- job-tracker build URLs (…/workspace/job-tracker/builds/ri.foundry.main.build.…).
-- Legacy `ri.orchestration.main.build.*` rows stay valid.
--
-- Idempotent: drops any prior restrictive rid CHECK (present on fresh installs
-- created from migration 077, absent on DBs where the table predated it) and
-- (re)adds the permissive form that accepts both namespaces. Existing rows are
-- all orchestration-namespaced, so the new CHECK validates without rewrites.

ALTER TABLE orchestration_builds
  DROP CONSTRAINT IF EXISTS orchestration_builds_rid_check;

ALTER TABLE orchestration_builds
  ADD CONSTRAINT orchestration_builds_rid_check
  CHECK (rid LIKE 'ri.foundry.main.build.%' OR rid LIKE 'ri.orchestration.main.build.%');
