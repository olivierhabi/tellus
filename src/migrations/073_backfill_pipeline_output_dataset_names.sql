-- ---------------------------------------------------------------------------
-- B-073 — Backfill foundry_datasets.name from pipeline_nodes.label for any
--        output dataset whose display name drifted from the canvas node
--        label.
--
-- Why this exists:
--   Prior to fix in src/services/deploymentService.ts (turn-of-2026-05-16),
--   the deploy path's existing-dataset UPDATE refreshed file_path,
--   row_count, original_filename, etc. but OMITTED `name`. After the very
--   first deploy of a pipeline output, the dataset's display name was
--   frozen at whatever the output node label was at creation time. Renaming
--   the output node in the canvas updated the *file* on the next deploy
--   (new sanitized filename) but the project file-tree continued to show
--   the stale name.
--
--   The deploy code is now fixed (display name is pinned to outputNode.label
--   on every deploy), but environments that were running the buggy code
--   may have datasets whose stored `name` is stale relative to the canvas.
--   This migration brings them into agreement.
--
-- Contracts:
--   073-C-01  Idempotent. `IS DISTINCT FROM` skips already-aligned rows.
--             Re-running the migration is a no-op and safe.
--   073-C-02  Source of truth = pipeline_nodes.label (the canvas value the
--             user sees and edits). DB.name follows the canvas, never the
--             other way around.
--   073-C-03  Scope = output-type nodes that own a foundry_datasets row
--             via config->>'outputDatasetId'. Non-output nodes (transform,
--             join, union, dataset) are not touched.
--   073-C-04  Trims surrounding whitespace and skips empty/whitespace-only
--             labels — those are invalid per the new deploy-time validator
--             (DeploymentService.validateOutputDatasetName) and would only
--             corrupt the dataset row if applied verbatim.
-- ---------------------------------------------------------------------------

BEGIN;

WITH renamed AS (
  UPDATE foundry_datasets AS d
     SET name       = trim(pn.label),
         updated_at = NOW()
    FROM pipeline_nodes pn
   WHERE pn.node_type = 'output'
     AND pn.label IS NOT NULL
     AND length(trim(pn.label)) BETWEEN 1 AND 255
     AND (pn.config ->> 'outputDatasetId') IS NOT NULL
     AND (pn.config ->> 'outputDatasetId')::uuid = d.id
     AND d.name IS DISTINCT FROM trim(pn.label)
RETURNING d.id
)
SELECT 'B-073 backfill: ' || count(*) || ' dataset(s) realigned' AS result
  FROM renamed;

COMMIT;
