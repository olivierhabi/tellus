-- ---------------------------------------------------------------------------
-- Backfill: function-backed Action provenance in the ontology_edit WAL.
--
-- Before executeFunctionAction threaded actionTypeApiName/executionId into
-- applyEdits, function-backed executions wrote their ontology_edit rows with
-- action_type_api_name = NULL. The Action Log Timeline (which reads
-- ontology_edit) therefore could not attribute those edits to their Action.
--
-- action_audit_log is the authoritative execution record. It carries the
-- affected (objectType, primaryKey) list for every successful function
-- execution. This backfill attributes any unattributed ontology_edit rows
-- that match a successful function execution on (object type, primary key,
-- actor, ±5s execution window).
--
-- Idempotent: rows already attributed are never touched, so the script is
-- safe to re-run at any time.
-- ---------------------------------------------------------------------------

BEGIN;

WITH fn_exec AS (
  SELECT
    execution_id,
    action_type_api_name,
    executed_by,
    executed_at,
    (obj->>'objectType')::text AS object_type,
    (obj->>'primaryKey')::text AS primary_key
  FROM action_audit_log
  CROSS JOIN LATERAL jsonb_array_elements(affected_objects) AS obj
  WHERE execution_mode = 'function'
    AND result = 'success'
)
UPDATE ontology_edit AS oe
SET
  action_type_api_name = fx.action_type_api_name,
  execution_id = fx.execution_id
FROM fn_exec AS fx
WHERE oe.action_type_api_name IS NULL
  AND oe.object_type_api_name = fx.object_type
  AND oe.primary_key = fx.primary_key
  AND oe.executed_by = fx.executed_by
  AND oe.executed_at BETWEEN fx.executed_at - interval '5 seconds'
                         AND fx.executed_at + interval '5 seconds';

COMMIT;
