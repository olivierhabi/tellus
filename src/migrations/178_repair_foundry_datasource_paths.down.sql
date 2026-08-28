-- Restore the most recent migration-178 before snapshot for every repaired
-- binding. This is intentionally audit-backed rather than heuristic.
WITH latest_run AS (
  SELECT migration_run_id
  FROM datasource_binding_repair_178_audit
  ORDER BY captured_at DESC
  LIMIT 1
), snapshots AS (
  SELECT DISTINCT ON (a.mapping_id)
    a.mapping_id,
    a.before_snapshot
  FROM datasource_binding_repair_178_audit a
  JOIN latest_run r USING (migration_run_id)
  WHERE a.outcome = 'repaired'
  ORDER BY a.mapping_id, a.captured_at DESC
)
UPDATE backing_datasource bd
SET file_path = s.before_snapshot->>'filePath',
    file_format = s.before_snapshot->>'fileFormat'
FROM snapshots s
WHERE bd.mapping_id = s.mapping_id;

