// ---------------------------------------------------------------------------
// Pipeline-Builder Temporal activities — PB-B4 follow-3.1.
//
// One activity today: `pbIcebergMaintenance`. Kept slim — the heavy
// lifting lives in services/pipelines/icebergMaintenance.ts and the
// PyIceberg sidecar, which the activity invokes synchronously. The
// activity boundary only exists so Temporal can schedule + retry +
// heartbeat the job without us owning a separate tick loop.
// ---------------------------------------------------------------------------

import { runIcebergMaintenanceOnce } from "../icebergMaintenance";
import foundryDb from "../../../config/foundryDb";
import { DeploymentService } from "../../deploymentService";
import { TransformService } from "../../transformService";

export interface IcebergMaintenanceActivityInput {
  pipelineIds?: string[];
}

export interface IcebergMaintenanceActivityResult {
  processed: number;
  succeeded: number;
  failed: number;
  /** Details per pipeline for audit / alerting. */
  details: Array<{
    pipelineId: string;
    compactedSnapshotId: number | null;
    snapshotCountAfter: number | null;
    error?: string;
  }>;
}

export async function pbIcebergMaintenance(
  input: IcebergMaintenanceActivityInput = {},
): Promise<IcebergMaintenanceActivityResult> {
  const details = await runIcebergMaintenanceOnce({
    pipelineIds: input.pipelineIds,
  });
  const failed = details.filter((d) => d.error).length;
  return {
    processed: details.length,
    succeeded: details.length - failed,
    failed,
    details,
  };
}

// ---------------------------------------------------------------------------
// PB-B1 spec-literal — `PipelineDeployWorkflow(projectId, pipelineId,
// deploymentId, idempotencyKey)` implemented as a Temporal workflow
// whose activity is `pbRunDeployment`. The activity delegates to
// DeploymentService.executeDeploymentById so the PG-dispatcher fallback
// (already wired in PB-B1) and the Temporal path share the same
// executeBuild code — no divergent behaviour between the two
// environments.
// ---------------------------------------------------------------------------

export interface RunDeploymentActivityInput {
  deploymentId: string;
  // PB-B9 — HTTP-layer trace context forwarded from the inbound
  // request through the workflow start into the activity so activity
  // logs and child spans inherit the originating trace_id.
  traceId?: string | null;
  spanId?: string | null;
}

export interface RunDeploymentActivityResult {
  deploymentId: string;
  terminal: boolean;
}

let _deploymentSingleton: DeploymentService | null = null;
function deployment(): DeploymentService {
  if (!_deploymentSingleton) {
    _deploymentSingleton = new DeploymentService(
      foundryDb,
      new TransformService(foundryDb),
    );
  }
  return _deploymentSingleton;
}

export async function pbRunDeployment(
  input: RunDeploymentActivityInput,
): Promise<RunDeploymentActivityResult> {
  // PB-B9 — wrap the deployment run in the inbound trace context so
  // structuredLogger emissions inside the activity/DuckDB/Iceberg code
  // path carry the same trace_id the HTTP handler logged under. If
  // no trace was propagated (legacy queued workflow, internal
  // trigger), fall through to a fresh trace so logs still correlate
  // across the activity boundary.
  const { withTraceFields } = await import("../../traceContext");
  await withTraceFields(
    {
      traceId: input.traceId ?? undefined,
      spanId: input.spanId ?? undefined,
      deploymentId: input.deploymentId,
    },
    () => deployment().executeDeploymentById(input.deploymentId, {
      workerId: `temporal-${input.deploymentId}`,
    }),
  );
  return { deploymentId: input.deploymentId, terminal: true };
}
