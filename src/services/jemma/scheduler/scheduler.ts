// ---------------------------------------------------------------------------
// B6 — Jemma scheduler.
//
// Single source of truth on:
//   1. QUEUED→RUNNING admission (calls WorkerAdapter.startPod)
//   2. Per-(repo,ref) singleton: a new push to a ref with an ACTIVE run
//      cancels the in-flight run before starting the new one.
//   3. Per-repo concurrency cap (4 by default per spec §B6).
//   4. Idempotency-Key replay (G-C-22).
//
// The scheduler does NOT manage stage transitions — that is driven by the
// worker adapter feeding events to `transition()` via the worker-side
// observer (wave 11).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { transition } from "../state/stateMachine";
import {
  RunStoreError,
  findRunByIdempotencyKey,
  getActiveRunForRef,
  insertRun,
  listActiveRunsForRepo,
  rebuildRunContext,
  transitionRunWithinTx,
  type RunRow,
} from "../store/runStore";
import {
  DEFAULT_SCHEDULER_CONFIG,
  type SchedulerConfig,
  type ScheduleOutcome,
  type WorkerAdapter,
} from "./types";
import type { RunTrigger } from "../state/types";

export interface SchedulerDeps {
  readonly pool: Pool;
  readonly worker: WorkerAdapter;
  readonly config?: Partial<SchedulerConfig>;
  /** Override clock for deterministic tests. */
  readonly nowIsoFn?: () => string;
  /** Override RID minter for deterministic tests. */
  readonly mintRunRid?: () => string;
}

export interface ScheduleArgs {
  readonly repositoryRid: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly trigger: RunTrigger;
  readonly triggeredBy: string; // UUID
  readonly idempotencyKey: string;
}

const RID_PREFIX = "ri.jemma.main.run.";

/**
 * Schedule (or re-schedule) a run. The HTTP route is responsible for
 * idempotency middleware (which lives at the wire layer); this scheduler
 * additionally enforces idempotent replay against the persisted ledger so
 * that even if the wire-layer cache misses, identical inputs do not produce
 * duplicate runs.
 */
export async function scheduleRun(
  deps: SchedulerDeps,
  args: ScheduleArgs,
): Promise<ScheduleOutcome> {
  const cfg: SchedulerConfig = {
    ...DEFAULT_SCHEDULER_CONFIG,
    ...(deps.config ?? {}),
  };
  const nowIso = (deps.nowIsoFn ?? defaultNowIso)();
  const mintRid = deps.mintRunRid ?? defaultMintRunRid;

  // 1. Idempotency replay — same key + same triggeredBy returns the existing run.
  const replay = await findRunByIdempotencyKey(deps.pool, args.idempotencyKey, args.triggeredBy);
  if (replay) {
    return { kind: "replay", run: replay };
  }

  // 2. Per-(repo,ref) singleton: cancel any ACTIVE run on the same ref.
  const inflight = await getActiveRunForRef(deps.pool, args.repositoryRid, args.ref);
  let cancelledRid: string | null = null;
  if (inflight) {
    await cancelInFlightRun(deps, inflight, "cancelled-by-newer-push", nowIso);
    cancelledRid = inflight.rid;
  }

  // 3. Per-repo capacity cap. Re-read AFTER the cancellation above so the
  //    cancelled run is no longer counted.
  const active = await listActiveRunsForRepo(deps.pool, args.repositoryRid);
  if (active.length >= cfg.perRepoActiveCap) {
    return { kind: "capacity-exceeded", reason: "per-repo-cap" };
  }

  // 4. Insert the new QUEUED run + 5 PENDING stages.
  const newRid = mintRid();
  let inserted: RunRow;
  try {
    inserted = await insertRun(deps.pool, {
      rid: newRid,
      repositoryRid: args.repositoryRid,
      ref: args.ref,
      commitSha: args.commitSha,
      trigger: args.trigger,
      triggeredBy: args.triggeredBy,
      idempotencyKey: args.idempotencyKey,
    });
  } catch (err) {
    if (err instanceof RunStoreError && err.code === "ACTIVE_RUN_EXISTS_FOR_REF") {
      // Race: another scheduler invocation inserted between our cancel + insert.
      // The contracted answer is to surface as capacity-exceeded so the caller
      // can retry; the in-flight run is still the latest valid run.
      return { kind: "capacity-exceeded", reason: "per-repo-cap" };
    }
    throw err;
  }

  // 5. Best-effort startPod. On image-unavailable we transition to FAILED.
  try {
    const { podName } = await deps.worker.startPod({
      runRid: inserted.rid,
      repositoryRid: inserted.repositoryRid,
      commitSha: inserted.commitSha,
    });
    // QUEUED → RUNNING via state machine.
    await driveTransition(deps.pool, inserted.rid, {
      kind: "scheduler-picked",
      podName,
      nowIso,
    });
    const refreshed = await rebuildRunContext(deps.pool, inserted.rid);
    if (!refreshed) {
      // Should be unreachable — we just inserted the row.
      return { kind: "started", run: inserted, cancelledRid };
    }
    return { kind: "started", run: refreshed.row, cancelledRid };
  } catch (err) {
    const e = err as { kind?: string };
    if (e?.kind === "image-unavailable") {
      // QUEUED → FAILED with reason image-unavailable.
      await driveTransition(deps.pool, inserted.rid, { kind: "image-unavailable", nowIso });
      return { kind: "image-unavailable" };
    }
    throw err;
  }
}

/**
 * Drive a state-machine transition AND persist the result in one tx.
 * Throws if the persisted state is incompatible with the requested event.
 */
async function driveTransition(
  pool: Pool,
  rid: string,
  event: Parameters<typeof transition>[1],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // Lock the row to prevent racing transitions.
      await client.query(`SELECT 1 FROM jemma_run WHERE rid = $1 FOR UPDATE`, [rid]);
      const ctx = await loadCtxForUpdate(client, rid);
      if (!ctx) {
        throw new RunStoreError("RUN_NOT_FOUND", `run ${rid} not found in transition`);
      }
      const next = transition(ctx, event);
      await transitionRunWithinTx(client, rid, next.nextContext);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

async function loadCtxForUpdate(
  client: import("pg").PoolClient,
  rid: string,
): Promise<Parameters<typeof transition>[0] | null> {
  const r = await client.query(
    `SELECT state, pod_name, queued_at, started_at, finished_at, failure_reason
       FROM jemma_run WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];

  const stages = await client.query(
    `SELECT stage_name, state FROM jemma_run_stage
      WHERE run_rid = $1
      ORDER BY array_position(
        ARRAY['setup','lint','test','build','publish']::text[],
        stage_name
      )`,
    [rid],
  );

  return {
    state: row.state,
    podName: (row.pod_name as string | null) ?? null,
    currentStage: stages.rows.find((s: { state: string }) => s.state === "RUNNING")?.stage_name
      ?? null,
    stages: stages.rows.map((s: { stage_name: string; state: string }) => ({
      name: s.stage_name as Parameters<typeof transition>[0]["stages"][number]["name"],
      state: s.state as Parameters<typeof transition>[0]["stages"][number]["state"],
    })),
    queuedAt: (row.queued_at as Date).toISOString(),
    startedAt: row.started_at ? (row.started_at as Date).toISOString() : null,
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    failureReason: row.failure_reason ?? null,
  };
}

async function cancelInFlightRun(
  deps: SchedulerDeps,
  inflight: RunRow,
  reason: "cancelled-by-newer-push" | "cancelled-by-user",
  nowIso: string,
): Promise<void> {
  // 1. Persist the state-machine transition. This frees the partial UQ slot.
  await driveTransition(deps.pool, inflight.rid, { kind: "cancel", reason, nowIso });

  // 2. Best-effort signalCancel to the worker (graceful 30s SIGTERM).
  if (inflight.podName) {
    try {
      await deps.worker.signalCancel({
        runRid: inflight.rid,
        podName: inflight.podName,
        reason,
      });
    } catch {
      // Cancellation is best-effort at the worker layer; the run is already
      // marked CANCELLED in the database which is the authoritative state.
    }
  }
}

// ---------------------------------------------------------------------------
// Exposed for the HTTP cancelRun route.
// ---------------------------------------------------------------------------

export async function cancelRunByUser(
  deps: SchedulerDeps,
  rid: string,
): Promise<{ kind: "cancelled" } | { kind: "not-found" } | { kind: "already-terminal" }> {
  const ctx = await rebuildRunContext(deps.pool, rid);
  if (!ctx) return { kind: "not-found" };
  const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
  if (TERMINAL.has(ctx.row.state)) return { kind: "already-terminal" };

  const nowIso = (deps.nowIsoFn ?? defaultNowIso)();
  await cancelInFlightRun(deps, ctx.row, "cancelled-by-user", nowIso);
  return { kind: "cancelled" };
}

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

function defaultNowIso(): string {
  return new Date().toISOString();
}

function defaultMintRunRid(): string {
  // Crypto-strong UUIDv4 from node:crypto; production keycloak UUIDs are also
  // v4 by construction so the format is consistent.
  return RID_PREFIX + randomUUID();
}
