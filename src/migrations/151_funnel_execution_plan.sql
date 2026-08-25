-- ---------------------------------------------------------------------------
-- 151 — Immutable per-run funnel execution plan (FUNN-ISO-4).
--
-- Terminal validation previously hard-coded the 4-stage requirement, which
-- married old runs to the CURRENT code's pipeline shape. Now every run row
-- persists an immutable snapshot of the pipeline definition it was
-- dispatched under; funnelStateProjection's verifyTerminalConsistency
-- derives completeness from the ROW, not from the module constant. A
-- redeployed pipeline definition can never silently rewrite the completion
-- criteria of in-flight history.
--
-- Plan v1 = the historical 4-stage shape.
-- ---------------------------------------------------------------------------

ALTER TABLE funnel_run
  ADD COLUMN IF NOT EXISTS definition_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS execution_plan JSONB NOT NULL DEFAULT '
  {
    "definitionVersion": 1,
    "requiredStages": ["changelog", "merge", "indexing", "hydration"],
    "optionalStages": [],
    "stageDependencies": {
      "changelog": [],
      "merge": ["changelog"],
      "indexing": ["changelog", "merge"],
      "hydration": ["changelog"]
    }
  }';
