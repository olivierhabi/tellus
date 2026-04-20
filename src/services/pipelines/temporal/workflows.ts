// ---------------------------------------------------------------------------
// Pipeline-Builder Temporal workflows — PB-B4 follow-3.1.
//
// `icebergMaintenanceWorkflow` wraps the compact+expire activity so it
// can run under Temporal scheduling (the Funnel's Temporal worker is
// the authoritative driver when connected; the interval loop in
// icebergMaintenance.ts is the fallback for Temporal-disconnected
// deployments — mirrors funnelDispatcher's posture).
// ---------------------------------------------------------------------------

import { proxyActivities } from "@temporalio/workflow";
import type {
  IcebergMaintenanceActivityInput,
  IcebergMaintenanceActivityResult,
} from "./activities";

const { pbIcebergMaintenance } = proxyActivities<{
  pbIcebergMaintenance(
    input: IcebergMaintenanceActivityInput,
  ): Promise<IcebergMaintenanceActivityResult>;
}>({
  // A maintenance round is bounded by the catalog RTT + per-pipeline
  // compact cost. 30 min is deliberately generous so expiration of
  // long snapshot chains doesn't time out; Temporal retries handle
  // transient failures. Heartbeats are not needed — the activity is
  // blocking and short relative to the timeout.
  startToCloseTimeout: "30 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "10 seconds",
    maximumInterval: "5 minutes",
    backoffCoefficient: 2.0,
  },
});

// PB-B1 spec-literal — PipelineDeployWorkflow drives a supervised
// deploy via Temporal. Activity retries honour the deploy workflow's
// idempotency-key story (PB-B1 startDeployment); a mid-activity crash
// replays the SAME deploymentId without producing a duplicate
// pipeline_deployments row.
const { pbRunDeployment } = proxyActivities<{
  pbRunDeployment(input: {
    deploymentId: string;
    traceId?: string | null;
    spanId?: string | null;
  }): Promise<{ deploymentId: string; terminal: boolean }>;
}>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "10 seconds",
    maximumInterval: "2 minutes",
    backoffCoefficient: 2.0,
  },
});

export interface IcebergMaintenanceWorkflowInput {
  pipelineIds?: string[];
}

export async function icebergMaintenanceWorkflow(
  input: IcebergMaintenanceWorkflowInput = {},
): Promise<IcebergMaintenanceActivityResult> {
  return pbIcebergMaintenance(input);
}

export interface PipelineDeployWorkflowInput {
  projectId: string;
  pipelineId: string;
  deploymentId: string;
  idempotencyKey: string;
  // PB-B9 — inbound HTTP trace context. Carried as workflow args so
  // activity logs can be correlated with the originating request.
  // Optional for back-compat with queued workflows that predate the
  // trace-propagation wiring.
  traceId?: string | null;
  spanId?: string | null;
}

/**
 * PB-B1 — drives a supervised deploy through the same
 * executeDeploymentById code path the PG dispatcher uses, so the two
 * execution environments are behavioural twins.
 *
 * PB-B9 — traceId/spanId are passed to the activity so structuredLogger
 * emits JSON lines tagged with the same trace_id the inbound HTTP
 * handler logged under. Deterministic: we do not read clocks or random
 * values — only consume the pre-set workflow args.
 */
export async function pipelineDeployWorkflow(
  input: PipelineDeployWorkflowInput,
): Promise<{ deploymentId: string; terminal: boolean }> {
  return pbRunDeployment({
    deploymentId: input.deploymentId,
    traceId: input.traceId ?? null,
    spanId: input.spanId ?? null,
  });
}
