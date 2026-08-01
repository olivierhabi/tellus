-- Down migration for 151_funnel_execution_plan.sql (diagnostics-only).
ALTER TABLE funnel_run DROP COLUMN IF EXISTS definition_version;
ALTER TABLE funnel_run DROP COLUMN IF EXISTS execution_plan;
