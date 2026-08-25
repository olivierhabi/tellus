// ---------------------------------------------------------------------------
// B5 — Table-import schedule manager (Temporal Schedules).
//
// Foundry-parity scheduling on the platform's existing, durable scheduling
// engine (Temporal — already running as `tellus-temporal`). One Schedule per
// import drives `tableImportSyncWorkflow` on a cron (with IANA timezone) or a
// fixed interval, with:
//   - overlap = SKIP   → a tick while the prior build is still running is
//                        skipped (matches the single-active-build lock).
//   - catchupWindow    → bounded catch-up after downtime (no backfill storm).
// Temporal owns next-fire computation (cron + timezone + DST), durability, and
// multi-replica safety — so this replaces hand-rolled cron math.
//
// Best-effort + idempotent: callable at every boot to (re)sync schedules from
// the DB. When Temporal is unreachable it no-ops and the DB-poll scheduler
// (interval-only) remains the fallback.
// ---------------------------------------------------------------------------

import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  type ScheduleOverlapPolicy,
  type ScheduleSpec,
} from "@temporalio/client";
import { getEnvironmentIdentity } from "../../../../config/environmentIdentity";

const PREFIX = "table-import-";
const OVERLAP: ScheduleOverlapPolicy = "SKIP";
// Milliseconds (a valid Temporal Duration) — bounds catch-up after downtime.
const CATCHUP_WINDOW =
  Number(process.env.TELLUS_TABLE_IMPORT_CATCHUP_WINDOW_MS) || 60_000;

export function scheduleIdFor(importRid: string): string {
  return `${PREFIX}${importRid}`;
}

export interface ImportScheduleSpec {
  /** Cron expression (5/6 field). Mutually exclusive with intervalMinutes. */
  cron?: string | null;
  /** Fixed cadence in minutes. Mutually exclusive with cron. */
  intervalMinutes?: number | null;
  /** IANA timezone for cron evaluation (default UTC). */
  timezone?: string | null;
}

export interface ScheduleOpResult {
  ok: boolean;
  reason?: string;
}

async function connect(): Promise<Client | null> {
  // FUNN-ISO: deployment-scoped namespace, never implicit sharing.
  const identity = getEnvironmentIdentity();
  try {
    const connection = await Connection.connect({ address: identity.temporalAddress });
    return new Client({ connection, namespace: identity.temporalNamespace, identity: identity.workerIdentity });
  } catch (err) {
    console.warn(`[table-import-schedule] temporal unreachable: ${(err as Error).message}`);
    return null;
  }
}

function buildSpec(spec: ImportScheduleSpec): ScheduleSpec {
  if (spec.cron && spec.cron.trim()) {
    return {
      cronExpressions: [spec.cron.trim()],
      timezone: spec.timezone?.trim() || "UTC",
    };
  }
  if (spec.intervalMinutes && spec.intervalMinutes > 0) {
    return { intervals: [{ every: `${spec.intervalMinutes}m` }] };
  }
  throw new Error("schedule requires either a cron expression or intervalMinutes");
}

/**
 * Create or update the Temporal Schedule for an import. Idempotent. Returns
 * `{ok:false}` (never throws) when Temporal is down so the caller can fall back.
 * A genuinely invalid cron surfaces as `{ok:false, reason}` for the API to 400.
 */
export async function upsertImportSchedule(
  importRid: string,
  spec: ImportScheduleSpec,
  taskQueueOverride?: string,
): Promise<ScheduleOpResult> {
  let temporalSpec: ScheduleSpec;
  try {
    temporalSpec = buildSpec(spec);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const client = await connect();
  if (!client) return { ok: false, reason: "temporal-unreachable" };

  const taskQueue = taskQueueOverride ?? getEnvironmentIdentity().temporalTaskQueue;
  const scheduleId = scheduleIdFor(importRid);
  const action = {
    type: "startWorkflow" as const,
    workflowType: "tableImportSyncWorkflow",
    taskQueue,
    workflowId: `table-import-sync-${importRid}`,
    args: [{ importRid }],
  };
  const policies = { overlap: OVERLAP, catchupWindow: CATCHUP_WINDOW };

  try {
    await client.schedule.create({ scheduleId, spec: temporalSpec, action, policies });
    return { ok: true };
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) {
      try {
        const handle = client.schedule.getHandle(scheduleId);
        await handle.update((prev) => ({ ...prev, spec: temporalSpec, action, policies }));
        return { ok: true, reason: "updated" };
      } catch (e2) {
        return { ok: false, reason: `update failed: ${(e2 as Error).message}` };
      }
    }
    // Bad cron / invalid spec surfaces here.
    return { ok: false, reason: `create failed: ${(err as Error).message}` };
  } finally {
    await client.connection.close().catch(() => undefined);
  }
}

/** Delete the import's schedule (idempotent; no-op if absent or Temporal down). */
export async function deleteImportSchedule(importRid: string): Promise<ScheduleOpResult> {
  const client = await connect();
  if (!client) return { ok: false, reason: "temporal-unreachable" };
  try {
    await client.schedule.getHandle(scheduleIdFor(importRid)).delete();
    return { ok: true };
  } catch (err) {
    // Idempotent: a schedule that is already gone (or whose backing workflow
    // has completed from a prior delete) is treated as a successful no-op.
    const msg = (err as Error).message;
    if (/not.?found|already completed/i.test(msg)) return { ok: true, reason: "absent" };
    return { ok: false, reason: msg };
  } finally {
    await client.connection.close().catch(() => undefined);
  }
}

/** Describe the schedule (next fire times etc.) — used by tests + the API. */
export async function describeImportSchedule(
  importRid: string,
): Promise<{ ok: boolean; nextActionTimes?: Date[]; reason?: string }> {
  const client = await connect();
  if (!client) return { ok: false, reason: "temporal-unreachable" };
  try {
    const desc = await client.schedule.getHandle(scheduleIdFor(importRid)).describe();
    return { ok: true, nextActionTimes: desc.info.nextActionTimes };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    await client.connection.close().catch(() => undefined);
  }
}
