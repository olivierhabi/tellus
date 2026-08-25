// ---------------------------------------------------------------------------
// Temporal schedule helper — PB-B4 follow-3.1.
//
// Creates (or updates) the schedule that fires
// `icebergMaintenanceWorkflow` on a cron. Idempotent: safe to call at
// every server boot. When Temporal is unreachable this no-ops and the
// interval-loop fallback in services/pipelines/icebergMaintenance.ts
// carries the compaction/expiration work.
// ---------------------------------------------------------------------------

import { Client, Connection, ScheduleAlreadyRunning } from "@temporalio/client";
import { getEnvironmentIdentity } from "../../../config/environmentIdentity";

const SCHEDULE_ID = "pb-b4-iceberg-maintenance";
const DEFAULT_CRON = process.env.PB_B4_MAINTENANCE_CRON ?? "0 */1 * * *"; // hourly

export interface EnsureScheduleResult {
  scheduled: boolean;
  reason?: string;
}

export async function ensureIcebergMaintenanceSchedule(): Promise<EnsureScheduleResult> {
  // FUNN-ISO: deployment-scoped namespace + queue, never implicit sharing.
  const identity = getEnvironmentIdentity();
  const address = identity.temporalAddress;
  const namespace = identity.temporalNamespace;
  const taskQueue = identity.temporalTaskQueue;

  let connection: Connection;
  try {
    connection = await Connection.connect({ address });
  } catch (err) {
    return {
      scheduled: false,
      reason: `temporal unreachable: ${(err as Error).message}`,
    };
  }

  const client = new Client({ connection, namespace, identity: identity.workerIdentity });
  const scheduleClient = client.schedule;

  try {
    // createSchedule is idempotent when combined with the
    // `ScheduleAlreadyRunning` error trap. Using `createSchedule` rather
    // than `getHandle().setOptions(...)` keeps the code simple and
    // resilient to version drift on the Temporal SDK.
    await scheduleClient.create({
      scheduleId: SCHEDULE_ID,
      spec: { cronExpressions: [DEFAULT_CRON] },
      action: {
        type: "startWorkflow",
        workflowType: "icebergMaintenanceWorkflow",
        taskQueue,
        args: [{}],
      },
      policies: {
        overlap: "SKIP", // skip if previous run is still going
        catchupWindow: "5m",
      },
    });
    return { scheduled: true };
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      // Already created; update the cron spec in case operators tweaked
      // the env var. Failures here are non-fatal — the existing schedule
      // keeps firing.
      try {
        const handle = scheduleClient.getHandle(SCHEDULE_ID);
        await handle.update((prev) => ({
          ...prev,
          spec: { cronExpressions: [DEFAULT_CRON] },
        }));
      } catch {
        /* ignore */
      }
      return { scheduled: true, reason: "already-existed" };
    }
    return {
      scheduled: false,
      reason: `schedule create failed: ${(err as Error).message}`,
    };
  }
}
