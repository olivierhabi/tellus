// ---------------------------------------------------------------------------
// Iceberg compaction + snapshot expiration — PB-B4 (follow-3).
//
// The spec wants these as Temporal workflows in the same worker as the
// Funnel's compaction work. This module is the honest-minimum equivalent:
// a supervised interval loop that walks every Iceberg-backed pipeline
// output and issues `compact` + `expire_snapshots(older_than=now-30d,
// retain_last=100)` via the PyIceberg sidecar. The loop self-throttles
// (a slow tick doesn't stack) and is safe to run in multiple pods —
// sidecar commits go through Lakekeeper's OCC so duplicate invocations
// are rejected cleanly rather than corrupting metadata.
//
// Swap-in path to Temporal: when the Funnel's Temporal worker picks up
// pipeline workflows, expose two activities (`compactPipelineTable`,
// `expirePipelineSnapshots`) that wrap the same sidecar calls. The
// scheduled loop below becomes a fallback for Temporal-disconnected
// deployments (same posture as funnelDispatcher.ts).
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { icebergCompact, icebergExpire } from "./icebergSidecar";
import { resolveOutputTable } from "./icebergChangelogReader";

export interface MaintenanceOptions {
  intervalMs?: number;
  /** Only run against these pipelines (dev/tests). */
  pipelineIds?: string[];
  knex?: Knex;
}

let loopTimer: NodeJS.Timeout | null = null;
let loopRunning = false;

/**
 * Start the maintenance loop. Safe to call multiple times — subsequent
 * calls are no-ops. Default interval: 1h (matches Iceberg compaction
 * cadences seen in prod deployments of Lakekeeper-backed tables).
 */
export function startIcebergMaintenance(options: MaintenanceOptions = {}): void {
  if (loopTimer) return;
  const intervalMs = options.intervalMs ?? Number(process.env.PB_B4_MAINTENANCE_INTERVAL_MS ?? 3_600_000);
  loopTimer = setInterval(async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await tick(options);
    } catch (err) {
      console.warn(
        `[pb-b4/maintenance] tick failed: ${(err as Error).message}`,
      );
    } finally {
      loopRunning = false;
    }
  }, intervalMs);
  loopTimer.unref?.();
}

export function stopIcebergMaintenance(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
}

/**
 * Drain one round of maintenance against the supplied pipelines.
 * Exposed for tests — the loop above calls this internally.
 */
export async function runIcebergMaintenanceOnce(
  options: MaintenanceOptions = {},
): Promise<Array<{
  pipelineId: string;
  compactedSnapshotId: number | null;
  snapshotCountAfter: number | null;
  error?: string;
}>> {
  return tick(options);
}

async function tick(
  options: MaintenanceOptions,
): Promise<Array<{
  pipelineId: string;
  compactedSnapshotId: number | null;
  snapshotCountAfter: number | null;
  error?: string;
}>> {
  const knex = options.knex ?? foundryDb;
  const pipelines = await loadTargetPipelines(knex, options.pipelineIds ?? null);
  const out: Array<{
    pipelineId: string;
    compactedSnapshotId: number | null;
    snapshotCountAfter: number | null;
    error?: string;
  }> = [];
  for (const p of pipelines) {
    const ref = resolveOutputTable({
      projectId: p.project_id,
      pipelineId: p.id,
      pipelineName: p.name,
    });
    try {
      const compact = await icebergCompact(ref);
      const expire = await icebergExpire(ref);
      out.push({
        pipelineId: p.id,
        compactedSnapshotId: compact.snapshot_id,
        snapshotCountAfter: expire.snapshot_count_after,
      });
    } catch (err) {
      out.push({
        pipelineId: p.id,
        compactedSnapshotId: null,
        snapshotCountAfter: null,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

interface TargetPipeline {
  id: string;
  project_id: string;
  name: string;
}

async function loadTargetPipelines(
  knex: Knex,
  ids: string[] | null,
): Promise<TargetPipeline[]> {
  try {
    const q = knex("pipelines")
      .where({ output_format: "iceberg" })
      .select("id", "project_id", "name");
    if (ids && ids.length > 0) {
      q.whereIn("id", ids);
    }
    return await q;
  } catch {
    return [];
  }
}
