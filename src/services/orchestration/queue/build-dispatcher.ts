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
import {
  publishBuildEvent,
  onCancelRequest,
} from "../build-event-bus";

let queuePromise: Promise<BuildQueueHandle> | null = null;

const TERMINAL_KINDS: ReadonlySet<RuntimeEvent["kind"]> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Append one event to the durable log AND publish it to the live bus (so SSE
 * clients on any instance get it within ms). The DB row is authoritative; the
 * publish is a best-effort low-latency hint. Returns silently if the row was
 * pruned — the status update is what matters for correctness.
 */
async function appendAndPublish(
  buildRid: string,
  kind: RuntimeEvent["kind"],
  data: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const r = await pool.query<{ id: string | number; ts: Date | string }>(
      `INSERT INTO orchestration_build_events(build_rid, kind, data)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, ts`,
      [buildRid, kind, JSON.stringify(data ?? {})],
    );
    const row = r.rows[0];
    if (!row) return;
    const ts =
      row.ts instanceof Date
        ? row.ts.toISOString()
        : new Date(String(row.ts)).toISOString();
    void publishBuildEvent({
      buildRid,
      id: typeof row.id === "number" ? row.id : Number(row.id),
      kind,
      ts,
      data: data ?? {},
    });
  } catch {
    /* row may have been pruned; the status update is what matters */
  }
}

/**
 * Persist a single runtime event to the build's row + append-only event log,
 * and publish it to the live bus. Best-effort and idempotent: terminal/started
 * updates are guarded on the current status so a duplicate or out-of-order
 * event can't clobber an already-finished build. A terminal event is appended
 * ONLY if it actually transitioned the build — so an explicit cancel that has
 * already set 'cancelled' is not followed by a duplicate terminal event.
 */
/**
 * Roll a build's lifecycle into the owning `table_imports.status` so every
 * surface that reads the sync's status (the source-detail health pill, the
 * Overview "Build status" column, the imports list) reflects the LATEST build
 * — not the creation-time `{state:"draft"}`. Best-effort: the authoritative
 * status lives on `orchestration_builds`; this is a denormalised mirror.
 */
async function setImportStatus(buildRid: string, state: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE table_imports
          SET status = jsonb_build_object('state', $2::text), updated_at = now()
        WHERE rid = (SELECT import_rid FROM orchestration_builds WHERE rid = $1)`,
      [buildRid, state],
    );
  } catch {
    /* best-effort: orchestration_builds remains the source of truth */
  }
}

async function persist(e: RuntimeEvent): Promise<void> {
  if (e.kind === "started") {
    await appendAndPublish(e.buildRid, e.kind, e.data);
    await pool.query(
      `UPDATE orchestration_builds
          SET status = 'running', started_at = COALESCE(started_at, now())
        WHERE rid = $1 AND status = 'queued'`,
      [e.buildRid],
    );
    await setImportStatus(e.buildRid, "running");
    return;
  }

  if (e.kind === "progress") {
    await appendAndPublish(e.buildRid, e.kind, e.data);
    // The strategy emits a `committed` progress event carrying the row/byte
    // counts; capture them so the build-history view reflects what was written
    // (the terminal event itself carries no counts).
    if (e.data?.phase === "committed") {
      const totalRows = (e.data?.totalRows as number | undefined) ?? null;
      const bytes = (e.data?.bytesWritten as number | undefined) ?? null;
      await pool.query(
        `UPDATE orchestration_builds
            SET rows_written = COALESCE($2, rows_written),
                bytes_read = COALESCE($3, bytes_read)
          WHERE rid = $1 AND status IN ('queued', 'running')`,
        [e.buildRid, totalRows, bytes],
      );
    }
    return;
  }

  if (e.kind === "log") {
    await appendAndPublish(e.buildRid, e.kind, e.data);
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
    const upd = await pool.query(
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
    // Already terminal (e.g. an explicit cancel won the race) — skip the
    // duplicate terminal event + publish.
    if (upd.rowCount === 0) return;
    await appendAndPublish(e.buildRid, e.kind, e.data);

    // Mirror the terminal outcome onto the sync (timeout collapses to failed for
    // the import's coarse status enum: draft|ready|running|succeeded|failed|cancelled).
    await setImportStatus(
      e.buildRid,
      status === "succeeded" ? "succeeded" : status === "cancelled" ? "cancelled" : "failed",
    );

    // On success, refresh the Compass-visible dataset to "ready" + row count so
    // the project view reflects the materialised data. Best-effort; never let a
    // registry hiccup fail build-event persistence.
    if (status === "succeeded") {
      try {
        const r = await pool.query<{
          dataset_rid: string;
          display_name: string;
          config: { schema: string; table: string; targetTable?: string; warehouseRoot?: string };
          compass_folder_rid: string | null;
          tenant: string | null;
        }>(
          `SELECT ti.dataset_rid, ti.display_name, ti.config,
                  c.compass_folder_rid, c.tenant
             FROM orchestration_builds b
             JOIN table_imports ti ON ti.rid = b.import_rid
             LEFT JOIN connectivity_connections c ON c.rid = ti.connection_rid
            WHERE b.rid = $1`,
          [e.buildRid],
        );
        const row = r.rows[0];
        if (row) {
          const { registerSyncedDataset, persistSyncedSchema } = await import(
            "../../datasets/synced-dataset-registry"
          );
          await registerSyncedDataset({
            datasetRid: row.dataset_rid,
            name: row.display_name,
            compassFolderRid: row.compass_folder_rid,
            schema: row.config.schema,
            table: row.config.targetTable ?? row.config.table,
            warehouse: row.config.warehouseRoot ?? row.tenant ?? "default",
            status: "succeeded",
            rowCount: rowsWritten,
            fileSizeBytes: bytesRead,
          });
          // Persist the output's column scan into `dataset_columns` — the
          // Iceberg equivalent of the upload CSV parse job. Without this the
          // registry row has zero persisted columns and consumers of the
          // persisted schema (ontology backing-datasource registration)
          // fail with "has no columns yet". Best-effort: the build already
          // succeeded; a scan failure only degrades to live-preview reads.
          try {
            await persistSyncedSchema(
              String(row.dataset_rid).split(".").pop() ?? "",
              {
                schema: row.config.schema,
                table: row.config.targetTable ?? row.config.table,
                warehouseRoot: row.config.warehouseRoot,
              },
              row.tenant ?? "default",
            );
          } catch (scanErr) {
            logger.warn(
              { err: scanErr, datasetRid: row.dataset_rid },
              "sync schema scan failed (best-effort)",
            );
          }
        }
      } catch {
        /* best-effort */
      }
    }
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
  // Cross-instance cancel: when any instance requests a cancel, the instance
  // actually running the worker aborts it. Registered once with the queue
  // closure so the abort reaches the live job here.
  onCancelRequest((buildRid) => {
    void queue.cancel(buildRid).catch((err) =>
      logger.warn(
        { err, buildRid },
        "build cancel (via bus) failed",
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

/**
 * Abort a build's worker IF it is running on THIS instance. Best-effort and
 * non-throwing. Does nothing when the queue hasn't been initialised here (no
 * build has ever been dispatched in this process — the job, if any, runs on
 * another instance, which reacts to the Redis cancel request instead).
 */
export async function cancelLocalBuild(buildRid: string): Promise<void> {
  if (!queuePromise) return;
  try {
    const queue = await queuePromise;
    await queue.cancel(buildRid);
  } catch (err) {
    logger.warn({ err, buildRid }, "local build cancel failed");
  }
}

/** Test-only: drop the memoised queue so a fresh runtime can be injected. */
export function __resetBuildDispatcherForTest(): void {
  queuePromise = null;
}
