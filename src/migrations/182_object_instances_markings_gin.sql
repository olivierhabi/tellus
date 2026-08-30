-- GIN index on object_instances.markings for Workshop object-set marking
-- enforcement (P1). Required so the NOT EXISTS ... unnest(markings) filter
-- in postgresOssAdapter.ts uses an index scan rather than sequential scan
-- on large object sets.

CREATE INDEX IF NOT EXISTS idx_object_instances_markings_gin
  ON object_instances USING GIN(markings);