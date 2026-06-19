-- Down for 091 — restore the orchestration-only rid CHECK. Will fail if any
-- Foundry-namespaced builds exist; remove or rewrite them first.
ALTER TABLE orchestration_builds
  DROP CONSTRAINT IF EXISTS orchestration_builds_rid_check;

ALTER TABLE orchestration_builds
  ADD CONSTRAINT orchestration_builds_rid_check
  CHECK (rid LIKE 'ri.orchestration.main.build.%');
