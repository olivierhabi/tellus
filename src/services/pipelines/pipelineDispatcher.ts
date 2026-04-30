// ---------------------------------------------------------------------------
// Pipeline Dispatcher — PB-B1 supervised build loop.
//
// Background worker that consumes pending `pipeline_signal` rows and drives
// each deploy through `DeploymentService.executeDeploymentById`. Mirrors the
// Funnel's `funnelDispatcher.ts` posture exactly:
//   * FOR UPDATE SKIP LOCKED claim, 2s tick, self-throttled re-entry gate.
//   * Temporal preferred when connected (handoff-only — Temporal owns the
//     execution) otherwise this loop runs the deploy itself.
//   * Orphan sweeper reconciles `pipeline_deployments` rows stuck at
//     status='running' past their `max_run_duration_seconds` into 'failed'.
//
// The signal inbox exists per-pipeline (not per-project) because deploys
// serialize on the pipeline's output table; two deploys to the same
// pipeline_id must not race. The dispatcher therefore claims at most one
// signal per pipeline per tick.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { DeploymentService } from "../deploymentService";
import { TransformService } from "../transformService";
import { isTemporalConnected } from "../funnel/temporal/worker";

export interface DispatcherOptions {
  intervalMs?: number;
  /** If set, dispatcher only considers these pipeline IDs (dev/test). */
  pipelineIds?: string[];
  /** Override the deployment service (tests). */
  deploymentService?: DeploymentService;
  /** Override the knex handle (tests). */
  knex?: Knex;
}

let loopTimer: NodeJS.Timeout | null = null;
let loopRunning = false;
let sweeperTickCounter = 0;

/**
 * Start the dispatcher loop. Safe to call multiple times — subsequent
 * calls are no-ops.
 */
export function startPipelineDispatcher(options: DispatcherOptions = {}): void {
  if (loopTimer) return;
  const intervalMs = options.intervalMs ?? 2_000;
  loopTimer = setInterval(async () => {
    if (loopRunning) return;
    loopRunning = true;
    try {
      await tick(options);
    } catch (err) {
      console.warn(
        `[pipelines/dispatcher] tick failed: ${(err as Error).message}`
      );
    } finally {
      loopRunning = false;
    }
  }, intervalMs);
  loopTimer.unref?.();
}

export function stopPipelineDispatcher(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  sweeperTickCounter = 0;
}

/**
 * Drain pending signals once. Exposed so tests can pump the loop
 * deterministically without waiting on setInterval.
 */
export async function drainPendingPipelineSignals(
  options: DispatcherOptions = {}
): Promise<number> {
  return tick(options);
}

/**
 * Reconcile orphan deployments: any row in status='running' past its
 * max_run_duration_seconds is marked failed with
 * error_message='supervisor_timeout'. Exposed for tests + for the
 * startup sweep in server.ts so a pod restart doesn't leave the UI
 * polling a "running" deploy forever.
 */
export async function sweepOrphanPipelineDeployments(
  knex: Knex = foundryDb
): Promise<{ sweptIds: string[] }> {
  const rows = await knex.raw(
    `UPDATE pipeline_deployments
        SET status = 'failed',
            error_message = COALESCE(error_message, 'supervisor_timeout'),
            finished_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at))::integer * 1000
      WHERE status = 'running'
        AND started_at < NOW() - (max_run_duration_seconds || ' seconds')::interval
      RETURNING id`
  );
  // knex.raw on pg returns { rows: [...] }
  const sweptIds: string[] = (rows?.rows ?? rows ?? []).map(
    (r: { id: string }) => r.id
  );
  if (sweptIds.length > 0) {
    console.log(
      `[pipelines/dispatcher] swept ${sweptIds.length} orphan deploy(s): ${sweptIds.join(",")}`
    );
    // PB-B9 — pipeline_orphan_runs_swept_total counter, paralleling the
    // Funnel's funnel_orphan_runs_swept_total. Emitted per sweep round
    // so on-call can alert on repeated orphan bursts.
    try {
      const { recordOrphanSwept } = await import("./metrics");
      recordOrphanSwept(sweptIds.length);
    } catch {
      /* metrics must never block the dispatcher */
    }
  }
  return { sweptIds };
}

async function tick(options: DispatcherOptions): Promise<number> {
  const knex = options.knex ?? foundryDb;
  // Orphan sweeper runs every 5 minutes (150 ticks @ 2s default) per
  // PB-B1 spec literal. Matches funnelDispatcher's orphan cadence so
  // the two subsystems have aligned recovery SLOs.
  sweeperTickCounter = (sweeperTickCounter + 1) % 150;
  if (sweeperTickCounter === 0) {
    try {
      await sweepOrphanPipelineDeployments(knex);
    } catch (err) {
      console.warn(
        `[pipelines/dispatcher] orphan sweep failed: ${(err as Error).message}`
      );
    }
  }

  const pipelineIds =
    options.pipelineIds ?? (await listPipelinesWithPendingSignals(knex));
  if (pipelineIds.length === 0) return 0;

  const deploymentService =
    options.deploymentService ??
    new DeploymentService(knex, new TransformService(knex));

  const temporalActive = isTemporalConnected();
  let processed = 0;

  for (const pipelineId of pipelineIds) {
    const signal = await claimNextSignal(knex, pipelineId);
    if (!signal) continue;

    try {
      if (signal.signal_type === "cancelDeployment") {
        // Cancellation is cooperative: the deploymentService worker polls
        // pipeline_deployments.cancellation_requested_at between outputs.
        // We don't need to do anything here except mark the signal
        // consumed (already done inside claimNextSignal).
        processed++;
        continue;
      }

      if (signal.signal_type !== "deployStart") continue;
      if (!signal.deployment_id) continue;

      if (temporalActive) {
        // When Temporal is connected it owns execution; the API layer
        // has already issued `signalWithStart` against the worker.
        // Nothing for the PG dispatcher to do beyond consuming the row.
        processed++;
        continue;
      }

      await deploymentService.executeDeploymentById(signal.deployment_id);
      processed++;
    } catch (err) {
      console.warn(
        `[pipelines/dispatcher] signal ${signal.signal_id} failed: ${(err as Error).message}`
      );
    }
  }
  return processed;
}

interface PipelineSignalRow {
  signal_id: string;
  pipeline_id: string;
  project_id: string;
  deployment_id: string | null;
  signal_type: "deployStart" | "cancelDeployment";
  payload: Record<string, unknown>;
}

/**
 * Claim the oldest un-consumed signal for this pipeline. Uses a
 * `FOR UPDATE SKIP LOCKED` CTE so concurrent dispatchers in a multi-pod
 * deployment never hand the same signal to two workers.
 */
async function claimNextSignal(
  knex: Knex,
  pipelineId: string
): Promise<PipelineSignalRow | null> {
  const res = await knex.raw(
    `WITH next_signal AS (
        SELECT signal_id
          FROM pipeline_signal
         WHERE pipeline_id = ?
           AND consumed_at IS NULL
         ORDER BY received_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
     )
     UPDATE pipeline_signal s
        SET consumed_at = NOW(),
            consumed_by_deployment_id = s.deployment_id
       FROM next_signal n
      WHERE s.signal_id = n.signal_id
    RETURNING s.signal_id, s.pipeline_id, s.project_id,
              s.deployment_id, s.signal_type, s.payload`,
    [pipelineId]
  );
  const row = (res?.rows ?? res ?? [])[0];
  if (!row) return null;
  return {
    signal_id: row.signal_id,
    pipeline_id: row.pipeline_id,
    project_id: row.project_id,
    deployment_id: row.deployment_id ?? null,
    signal_type: row.signal_type,
    payload:
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload ?? {},
  };
}

async function listPipelinesWithPendingSignals(knex: Knex): Promise<string[]> {
  try {
    const rows = await knex("pipeline_signal")
      .distinct("pipeline_id")
      .whereNull("consumed_at");
    return rows.map((r: { pipeline_id: string }) => r.pipeline_id);
  } catch {
    return [];
  }
}
