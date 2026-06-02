// ---------------------------------------------------------------------------
// Build dispatcher — process-wide singleton in front of the build queue.
//
// Why this exists: `POST /imports/:rid/execute` previously built a fresh
// runtime adapter + build queue ON EVERY REQUEST (creating a new worker /
// connection and re-registering listeners over shared module state), and the
// handler awaited the full dispatch before responding. A worker that hung —
// or a saturated concurrency cap — left the request pending until the 5s
// request budget tripped a 504, and the single-active lock was never released
// on the success path so subsequent executes coalesced for the full 1h TTL.
//
// This module fixes the lifecycle:
//   - The runtime adapter + build queue are initialised exactly ONCE, lazily,
//     and shared across all requests.
//   - A single subscriber persists the build lifecycle to the database
//     (queued → running → succeeded/failed/timeout) so build history reflects
//     reality instead of being stuck at "queued".
//   - `dispatchBuild` is fire-and-forget admission: it never blocks the HTTP
//     response and self-heals on failure (releases the coalescing lock and
//     marks the build failed) so a dispatch error can't wedge an import.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";
import { logger } from "../../../logging/pino";
import * as singleActive from "./single-active-build";
import { loadRuntimeAdapter } from "../runners/runtime-adapter";
import type { JobSpec, RuntimeEvent } from "../runners/runtime-adapter";
import { makeBuildQueue, type BuildQueueHandle } from "./build-queue";

let queuePromise: Promise<BuildQueueHandle> | null = null;

/** Runtime event kinds the append-only build_events log accepts. */
const EVENT_KINDS: ReadonlySet<RuntimeEvent["kind"]> = new Set([
  "started",
  "progress",
  "log",
  "succeeded",
  "failed",
  "cancelled",
]);

const TERMINAL_KINDS: ReadonlySet<RuntimeEvent["kind"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Persist a single runtime event to the build's row + append-only event log.
 * Best-effort and idempotent: terminal/started updates are guarded on the
 * current status so a duplicate or out-of-order event can't clobber a
 * already-finished build.
 */
async function persist(e: RuntimeEvent): Promise<void> {
  if (EVENT_KINDS.has(e.kind)) {
    await pool
      .query(
        `INSERT INTO orchestration_build_events(build_rid, kind, data)
         VALUES ($1, $2, $3::jsonb)`,
        [e.buildRid, e.kind, JSON.stringify(e.data ?? {})],
      )
      .catch(() => {
        /* row may have been pruned; the status update below is what matters */
      });
  }

  if (e.kind === "started") {
    await pool.query(
      `UPDATE orchestration_builds
          SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE rid = $1 AND status = 'queued'`,
      [e.buildRid],
    );
    return;
  }

  // The strategy emits a `committed` progress event carrying the row/byte
  // counts; capture them so the build-history view reflects what was written
  // (the terminal event itself carries no counts).
  if (e.kind === "progress" && e.data?.phase === "committed") {
    const totalRows = (e.data?.totalRows as number | undefined) ?? null;
    const bytes = (e.data?.bytesWritten as number | undefined) ?? null;
    await pool.query(
      `UPDATE orchestration_builds
          SET rows_written = COALESCE($2, rows_written),
              bytes_read = COALESCE($3, bytes_read)
        WHERE rid = $1 AND status IN ('queued', 'running')`,
      [e.buildRid, totalRows, bytes],
    );
    return;
  }

  if (TERMINAL_KINDS.has(e.kind)) {
    // The in-memory/bullmq runtimes both express a deadline kill as a
    // `failed` event carrying SIGKILL — surface that distinctly as `timeout`.
    const signal = (e.data?.signal as string | undefined) ?? null;
    const status =
      e.kind === "failed" && signal === "SIGKILL" ? "timeout" : e.kind;
    const exitCode = (e.data?.exitCode as number | undefined) ?? null;
    const reason = (e.data?.reason as string | undefined) ?? null;
    const bytesRead = (e.data?.bytesRead as number | undefined) ?? null;
    const rowsWritten = (e.data?.rowsWritten as number | undefined) ?? null;
    const snapshotRid = (e.data?.snapshotRid as string | undefined) ?? null;
    await pool.query(
      `UPDATE orchestration_builds
          SET status = $2,
              ended_at = now(),
              exit_code = $3,
              reason = $4,
              bytes_read = COALESCE($5, bytes_read),
              rows_written = COALESCE($6, rows_written),
              snapshot_rid = COALESCE($7, snapshot_rid)
        WHERE rid = $1 AND status IN ('queued', 'running')`,
      [e.buildRid, status, exitCode, reason, bytesRead, rowsWritten, snapshotRid],
    );
  }
}

async function initQueue(): Promise<BuildQueueHandle> {
  const runtime = await loadRuntimeAdapter();
  const queue = makeBuildQueue(runtime);
  queue.onEvent((e) => {
    void persist(e).catch((err) =>
      logger.error(
        { err, buildRid: e.buildRid, kind: e.kind },
        "failed to persist build event",
      ),
    );
  });
  return queue;
}

/** Lazily initialise (once) the shared runtime + build queue. */
function getQueue(): Promise<BuildQueueHandle> {
  if (!queuePromise) {
    queuePromise = initQueue().catch((err) => {
      // Allow a later request to retry initialisation rather than caching the
      // rejection forever.
      queuePromise = null;
      throw err;
    });
  }
  return queuePromise;
}

/**
 * Admit a build for background execution. Fire-and-forget: callers must NOT
 * await this on the request path. Resolves once the job is queued; on any
 * dispatch failure it releases the coalescing lock and marks the build failed
 * so the import is never left wedged.
 */
export async function dispatchBuild(spec: JobSpec): Promise<void> {
  try {
    const queue = await getQueue();
    queue.enqueue(spec, { weight: 1 });
  } catch (err) {
    logger.error(
      { err, buildRid: spec.buildRid, importRid: spec.importRid },
      "failed to dispatch build",
    );
    void singleActive.release(spec.importRid);
    await pool
      .query(
        `UPDATE orchestration_builds
            SET status = 'failed', ended_at = now(),
                reason = 'dispatch failed: ' || $2
          WHERE rid = $1 AND status IN ('queued', 'running')`,
        [spec.buildRid, err instanceof Error ? err.message : String(err)],
      )
      .catch(() => {
        /* nothing more we can do; already logged */
      });
  }
}

/** Test-only: drop the memoised queue so a fresh runtime can be injected. */
export function __resetBuildDispatcherForTest(): void {
  queuePromise = null;
}
