// ---------------------------------------------------------------------------
// Temporal workflows bundle — barrel file.
//
// Temporal's Worker.create() takes a single `workflowsPath` from which it
// compiles the workflow bundle. This module re-exports every workflow
// known to the `tellus-funnel-queue` so a single worker can drive the
// Funnel's ObjectTypeFunnelWorkflow alongside the Pipeline-Builder's
// PB-B4 `icebergMaintenanceWorkflow`.
// ---------------------------------------------------------------------------

export * from "./workflows";
export * from "../../pipelines/temporal/workflows";
// B5 — table-import sync workflow (driven by per-import Temporal Schedules).
export * from "../../connectivity/imports/temporal/workflows";
