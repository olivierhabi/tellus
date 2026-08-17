// ---------------------------------------------------------------------------
// Funnel state projection — FUNN-ISO-4/5 (fail-closed, CAS-safe)
//
// Bridge from the workflow audit log (`funnel_run`, written by every stage)
// to the UI-facing badge column (`funnel_state.status`, read by
// `objectType.indexingState` and `objectType.object_count`).
//
// Master history (pre-FUNN-ISO): a missing object type was a SILENT no-op
// (`outcome: "ot_missing"`), which is precisely how an activity that
// mistakenly executed against a foreign database produced a green
// "completed" Temporal run while the badge never advanced — the
// 2026-07-31 OlivierOrder stuck-"Indexing" incident.
//
// Fail-closed contract now:
//   * status='indexed' requires the run's stages {changelog, merge,
//     indexing, hydration} to ALL exist as 'succeeded' for THIS run_id, and
//     the run row's environment to match the projecting environment. Any
//     deviation → recordProjectionSkipped / recordStageEnvironmentInconsistency
//     and a FunnelStaleStateTransition throw (the workflow then lands in
//     'failed', never 'indexed').
//   * Terminal writes are compare-and-swapped: a stale run (older
//     active_run_started_at) can NEVER overwrite a newer run's state.
//   * funnel_state.environment_id adopts the first writer; a later
//     conflicting environment write throws FunnelExecutionEnvironmentMismatch.
//   * Missing object type → mark funnel_run 'cancelled' with
//     'object_type_deleted: …' when a run identity is known (explicit
//     terminal state for legitimate mid-run deletes); otherwise loud log +
//     metric. NEVER reported as "indexed".
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  funnelProjectionTotal,
  funnelProjectionFailuresTotal,
  funnelProjectionSeconds,
} from "../../metrics/funnelProjection";
import { eventBus } from "../../websocket/eventBus";
import {
  closeOpenStageRuns,
  closeOpenStageRunsByWorkflowId,
} from "./stageRunClosure";
import {
  recordMissingObjectType,
  recordProjectionSkipped,
  recordStageEnvironmentInconsistency,
} from "./isolationMetrics";
import {
  FunnelExecutionEnvironmentMismatch,
  FunnelStaleStateTransition,
} from "./environmentGuard";
import {
  parseExecutionPlan,
  UnknownFunnelDefinitionError,
  type FunnelExecutionPlan,
} from "./executionPlan";

export type FunnelStateStatus =
  | "not_indexed"
  | "indexing"
  | "indexed"
  | "failed"
  | "stale"
  | "cancelled";

/**
 * Where in the dispatcher lifecycle this projection is being emitted from.
 */
export type ProjectionPath = "pre" | "post" | "pre_temporal";

export interface ProjectFunnelTerminalOptions {
  runId?: string;
  errorMessage?: string;
  path?: ProjectionPath;
  objectsIndexed?: number;
  /** Driving signal id (Temporal path). */
  runKey?: string;
  // ------------------------------------------------------------------
  // FUNN-ISO identity + consistency inputs
  // ------------------------------------------------------------------
  /** Deployment environment stamping + CAS + cross-env guard. */
  environmentId?: string;
  /** Stable OT RID — used to recompute the RID-keyed temporal_workflow_id. */
  objectTypeRid?: string;
  /** Explicit permission to mark the run object_type_deleted when the OT is
   *  gone (the workflow's intentional-delete path). */
  allowObjectTypeDeletedMarking?: boolean;
}

interface RunIdentity {
  runId: string;
  startedAt: Date | null;
  environmentId: string | null;
  status: string;
}

// FUNN-ISO-4: terminal completeness derives from the RUN'S OWN persisted
// immutable execution plan (migration 151), never from this module's
// current pipeline shape — a redeployed pipeline definition must not
// rewrite the criteria for in-flight history.

/**
 * Resolve the run this projection is about, by runId or by runKey.
 *
 * Takes a NAMED-FIELD object on purpose. Until 2026-08-16 this took two bare
 * strings, `(objectTypeApiName, ontologyId, options)`, and BOTH call sites
 * passed them in the opposite order — one of them via a no-op
 * `ontologyIdPlaceholder()` helper whose doc comment asserted the wrong
 * order and made the bug look intentional. Consequence: on the runKey path the
 * fallback workflow id was built as `ObjectTypeFunnelWorkflow-<ontologyId>`,
 * which matches no row in `funnel_run`, so resolution silently returned null —
 * and a null run means `verifyTerminalConsistency` is SKIPPED. The one guard
 * that stops a run reaching terminal 'indexed' with a missing or failed stage
 * was inert for every runKey-only terminal. Two same-typed positional
 * parameters cannot be misordered when they are named fields.
 */
async function resolveRunIdentity(
  {
    objectTypeApiName,
    ontologyId,
    options,
  }: {
    objectTypeApiName: string;
    ontologyId: string;
    options: ProjectFunnelTerminalOptions;
  },
): Promise<RunIdentity | null> {
  if (options.runId) {
    const r = await query(
      `SELECT run_id, started_at, environment_id, status FROM funnel_run WHERE run_id = $1`,
      [options.runId],
    );
    if (!r.rows[0]) return null;
    return {
      runId: r.rows[0].run_id,
      startedAt: r.rows[0].started_at,
      environmentId: r.rows[0].environment_id ?? null,
      status: r.rows[0].status,
    };
  }
  if (options.runKey) {
    const wfId = options.objectTypeRid
      ? `ObjectTypeFunnelWorkflow/${ontologyId}/${options.objectTypeRid}`
      : `ObjectTypeFunnelWorkflow-${objectTypeApiName}`;
    const r = await query(
      `SELECT run_id, started_at, environment_id, status FROM funnel_run
        WHERE temporal_workflow_id = $1`,
      [`${wfId}:${options.runKey}`],
    );
    if (!r.rows[0]) return null;
    return {
      runId: r.rows[0].run_id,
      startedAt: r.rows[0].started_at,
      environmentId: r.rows[0].environment_id ?? null,
      status: r.rows[0].status,
    };
  }
  return null;
}

/**
 * Terminal 'indexed' must be impossible when a required stage is missing,
 * failed, skipped, or executed under a different environment identity.
 * Throws FunnelStaleStateTransition / FunnelExecutionEnvironmentMismatch.
 */
async function verifyTerminalConsistency(
  run: RunIdentity,
  objectTypeApiName: string,
  environmentId?: string,
): Promise<void> {
  if (environmentId && run.environmentId && run.environmentId !== environmentId) {
    recordStageEnvironmentInconsistency({
      reason: "run_env_mismatch",
      object_type: objectTypeApiName,
      run_environment: run.environmentId,
      projector_environment: environmentId,
    });
    throw new FunnelExecutionEnvironmentMismatch(
      "context_vs_db",
      environmentId,
      run.environmentId,
    );
  }
  // Read the run's persisted, immutable execution plan — the definition
  // to validate by. parseExecutionPlan fails closed on unknown shapes.
  let plan: FunnelExecutionPlan;
  {
    const pr = await query(
      `SELECT definition_version, execution_plan FROM funnel_run WHERE run_id = $1`,
      [run.runId],
    );
    try {
      plan = parseExecutionPlan(
        pr.rows[0]?.execution_plan ?? { definitionVersion: pr.rows[0]?.definition_version },
      );
    } catch (err) {
      recordProjectionSkipped({
        reason: "unknown_pipeline_definition",
        object_type: objectTypeApiName,
        run_environment: run.environmentId ?? "unknown",
      });
      throw err;
    }
  }
  const knownStages = new Set([
    ...plan.requiredStages,
    ...plan.optionalStages,
  ]);
  const stages = await query(
    `SELECT stage, status FROM funnel_stage_run WHERE run_id = $1`,
    [run.runId],
  );
  // A recorded stage outside the plan's vocabulary is a definition-evolution
  // violation: fail closed (never derive rules for unknown stages).
  const foreignStages = stages.rows
    .map((s: { stage: string }) => s.stage)
    .filter((s: string) => !knownStages.has(s as never));
  if (foreignStages.length > 0) {
    recordStageEnvironmentInconsistency({
      reason: "terminal_verify_foreign_stage",
      object_type: objectTypeApiName,
      stages: foreignStages.join(","),
    });
    throw new FunnelStaleStateTransition(
      `terminal 'indexed' rejected for run ${run.runId} (${objectTypeApiName}, plan v${plan.definitionVersion}): ` +
        `stage(s) not in the persisted execution plan: ${[...new Set(foreignStages)].join(", ")}`,
    );
  }
  // Duplicate stage-completed rows are de-duped by construction (unique
  // (run_id, stage, attempt) + Set) — the probe remains idempotent.
  const okStages = new Set(
    stages.rows
      .filter((s: { status: string }) => s.status === "succeeded")
      .map((s: { stage: string }) => s.stage),
  );
  const missing = plan.requiredStages.filter((s) => !okStages.has(s));
  if (missing.length > 0) {
    recordProjectionSkipped({
      reason: "terminal_verify_failed",
      object_type: objectTypeApiName,
      missing_stages: missing.join(","),
    });
    recordStageEnvironmentInconsistency({
      reason: "terminal_verify_missing_stages",
      object_type: objectTypeApiName,
      missing_stages: missing.join(","),
    });
    throw new FunnelStaleStateTransition(
      `terminal 'indexed' rejected for run ${run.runId} (${objectTypeApiName}, plan v${plan.definitionVersion}): ` +
        `required stage(s) missing or not succeeded: ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// projectFunnelTerminalToState
// ---------------------------------------------------------------------------

export async function projectFunnelTerminalToState(
  ontologyId: string,
  objectTypeApiName: string,
  status: FunnelStateStatus,
  options: ProjectFunnelTerminalOptions = {}
): Promise<void> {
  const path = options.path ?? "post";
  const startedAt = Date.now();
  const observeDuration = (outcome: "ok" | "ot_missing" | "db_error" | "skipped") => {
    try {
      funnelProjectionSeconds.observe(
        { status, outcome },
        (Date.now() - startedAt) / 1000,
      );
    } catch {
      /* metrics emission must never break the projection itself */
    }
  };
  try {
    const otRow = await query(
      `SELECT object_type_id FROM object_type
        WHERE ontology_id = $1 AND api_name = $2
        LIMIT 1`,
      [ontologyId, objectTypeApiName]
    );
    const objectTypeId = otRow.rows[0]?.object_type_id as string | undefined;
    if (!objectTypeId) {
      // FAIL-CLOSED: a missing OT is NEVER a skip-and-report-indexed.
      // When we know the run identity, the run gets the explicit terminal
      // state 'cancelled (object_type_deleted)' so the audit trail records
      // intent instead of a phantom success.
      recordMissingObjectType({
        object_type: objectTypeApiName,
        status,
        environment: options.environmentId ?? "unknown",
      });
      funnelProjectionTotal.inc({ status, outcome: "ot_missing", path });
      observeDuration("ot_missing");
      const run = await resolveRunIdentity({ ontologyId, objectTypeApiName, options });
      if (run && options.allowObjectTypeDeletedMarking) {
        await query(
          `UPDATE funnel_run
              SET status = 'cancelled',
                  error_message = $1,
                  completed_at = now()
            WHERE run_id = $2 AND status IN ('dispatch_pending','workflow_started','running')`,
          [
            `object_type_deleted: ${objectTypeApiName} not found in ontology ${ontologyId} (deleted mid-run or wrong database)`,
            run.runId,
          ]
        );
        // funnel_stage_run has no 'cancelled' status, so open stages are
        // closed as 'failed' carrying the cancellation reason. Without this the
        // stage rows outlive the terminal run and the UI spins forever on
        // whichever stage was in flight when the type was deleted.
        await closeOpenStageRuns(
          run.runId,
          `run cancelled: object_type_deleted (${objectTypeApiName} not found in ontology ${ontologyId})`,
        );
        console.warn(
          JSON.stringify({
            level: "warn",
            type: "funnel_object_type_deleted_mid_run",
            ontologyId,
            objectTypeApiName,
            runId: run.runId,
            environmentId: options.environmentId ?? null,
          }),
        );
        return;
      }
      console.warn(
        JSON.stringify({
          level: "warn",
          type: "funnel_missing_object_type",
          ontologyId,
          objectTypeApiName,
          status,
          environmentId: options.environmentId ?? null,
        }),
      );
      return;
    }

    // ---------------------------------------------------------------
    // Resolve run identity + guard terminal consistency
    // ---------------------------------------------------------------
    const run = await resolveRunIdentity({ ontologyId, objectTypeApiName, options });
    if ((status === "indexed" || status === "failed") && run) {
      if (status === "indexed") {
        await verifyTerminalConsistency(run, objectTypeApiName, options.environmentId);
      }
    }

    // Track payload deltas across the three success branches so the
    // single live-update emission at the end carries enough context
    // for the FE to merge directly into the React Query cache without
    // a follow-up refetch.
    let runObjects = 0;
    let lastIndexedAtIso: string | null = null;
    let errorMessageForEmit: string | null = null;

    if (status === "indexed") {
      // The badge shows the TOTAL object count, not the per-run delta —
      // otherwise a no-op re-run (merge upserts=0) clobbers the displayed
      // total back to 0 although all objects still exist. Authoritative
      // source: object_instances for this (ontology, type). The previous
      // per-run `merge.upserts` is still recorded in the run row's
      // objects_indexed column and stage output_json for audit.
      const n = await query(
        `SELECT count(*)::int AS n FROM object_instances
          WHERE ontology_id = $1 AND object_type_api_name = $2`,
        [ontologyId, objectTypeApiName],
      );
      runObjects = Number(n.rows[0]?.n ?? 0);
      if (typeof options.objectsIndexed === "number" && options.objectsIndexed !== runObjects) {
        console.log(
          JSON.stringify({
            level: "info",
            type: "funnel_terminal_count_reconciled",
            objectTypeApiName,
            runDelta: options.objectsIndexed,
            totalObjects: runObjects,
          }),
        );
      }
      // CAS: a stale run must never overwrite a newer run's terminal
      // state. active_run_started_at is the monotonic guard (set on the
      // pre-projection when the run was dispatched).
      const cas = await query(
        `INSERT INTO funnel_state
           (object_type_id, status, objects_indexed, last_indexed_at,
            error_message, environment_id, active_run_id, active_run_started_at)
         VALUES ($1, 'indexed', $2, now(), NULL, $3, $4, $5)
         ON CONFLICT (object_type_id) DO UPDATE SET
          status            = 'indexed',
          objects_indexed   = EXCLUDED.objects_indexed,
          last_indexed_at   = now(),
          error_message     = NULL,
          environment_id    = COALESCE(EXCLUDED.environment_id, funnel_state.environment_id),
          active_run_id     = EXCLUDED.active_run_id,
          active_run_started_at = EXCLUDED.active_run_started_at,
          updated_at        = now()
         WHERE funnel_state.active_run_started_at IS NULL
            OR funnel_state.active_run_started_at <= EXCLUDED.active_run_started_at`,
        [
          objectTypeId,
          runObjects,
          options.environmentId ?? null,
          run?.runId ?? null,
          run?.startedAt ?? null,
        ]
      );
      if (cas.rowCount === 0) {
        // Stale terminal activity — the newer run owns the badge. Loud,
        // metricated, and NOT an exception (the newer run is truth).
        recordProjectionSkipped({
          reason: "stale_terminal_overwrite_blocked",
          object_type: objectTypeApiName,
        });
        console.warn(
          JSON.stringify({
            level: "warn",
            type: "funnel_projection_stale_overwrite_blocked",
            ontologyId,
            objectTypeApiName,
            runId: run?.runId ?? null,
          }),
        );
        observeDuration("skipped");
        return;
      }
      // Environment mismatch guard on pre-existing state (cross-env write
      // into the badge is the split-brain signature).
      if (options.environmentId) {
        const envRow = await query(
          `SELECT environment_id FROM funnel_state WHERE object_type_id = $1`,
          [objectTypeId],
        );
        const existingEnv = envRow.rows[0]?.environment_id as string | null;
        if (existingEnv && existingEnv !== options.environmentId) {
          recordStageEnvironmentInconsistency({
            reason: "state_env_conflict",
            object_type: objectTypeApiName,
            state_environment: existingEnv,
            projector_environment: options.environmentId,
          });
          throw new FunnelExecutionEnvironmentMismatch(
            "context_vs_db",
            options.environmentId,
            existingEnv,
          );
        }
      }
      lastIndexedAtIso = new Date().toISOString();
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    } else if (status === "failed" || status === "cancelled") {
      await query(
        `INSERT INTO funnel_state
           (object_type_id, status, error_message, environment_id,
            active_run_id, active_run_started_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (object_type_id) DO UPDATE SET
           status        = EXCLUDED.status,
           error_message = EXCLUDED.error_message,
           environment_id = COALESCE(EXCLUDED.environment_id, funnel_state.environment_id),
           active_run_id = COALESCE(EXCLUDED.active_run_id, funnel_state.active_run_id),
           active_run_started_at = COALESCE(EXCLUDED.active_run_started_at, funnel_state.active_run_started_at),
           updated_at    = now()`,
        [
          objectTypeId,
          status,
          options.errorMessage ?? null,
          options.environmentId ?? null,
          run?.runId ?? null,
          run?.startedAt ?? null,
        ]
      );
      errorMessageForEmit = options.errorMessage ?? null;
      // Mark funnel_run failed too — keyed by the per-save
      // `temporal_workflow_id` (`ObjectTypeFunnelWorkflow-<apiName>:<runKey>`)
      // that `projectStageToPostgres` upserted. Without this, funnel_run stays
      // "running/<current_stage>" while Temporal is terminal FAILED (the OO7
      // bookkeeping divergence that made the UI read "stuck at changelog"
      // instead of "failed"). Only the Temporal path passes runKey; the PG
      // dispatcher path is already marked failed by durableWorkflow.ts.
      if (options.runKey) {
        const temporalWorkflowId = options.objectTypeRid
          ? `ObjectTypeFunnelWorkflow/${ontologyId}/${options.objectTypeRid}:${options.runKey}`
          : `ObjectTypeFunnelWorkflow-${objectTypeApiName}:${options.runKey}`;
        try {
          await query(
            `UPDATE funnel_run
                SET status = 'failed', completed_at = now(), error_message = $1
              WHERE temporal_workflow_id = $2
                AND status IN ('dispatch_pending','workflow_started','running')`,
            [options.errorMessage ?? null, temporalWorkflowId]
          );
          // Close the stage rows of whichever run just went terminal. Keyed by
          // workflow id (the run id is not known on this path) and scoped to
          // already-terminal runs, so a live run can never be touched. Both a
          // heartbeat timeout and a StartToClose timeout land here — those are
          // the stranded rows the boot sweeps could never reach, because the
          // sweeps only select runs still at 'running'.
          await closeOpenStageRunsByWorkflowId(
            temporalWorkflowId,
            `run failed: ${options.errorMessage ?? "no error message recorded"}`,
          );
        } catch (runErr) {
          console.warn(
            JSON.stringify({
              level: "warn",
              type: "funnel_run_failure_projection_failed",
              objectTypeApiName,
              runKey: options.runKey,
              error: (runErr as Error).message,
            })
          );
        }
      }
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    } else {
      // 'indexing' / 'not_indexed' / 'stale' — clear any prior error so
      // the UI doesn't keep displaying a stale failure copy. Copy the run
      // CAS anchor so a later stale terminal can't overwrite this state.
      await query(
        `INSERT INTO funnel_state
           (object_type_id, status, error_message, environment_id,
            active_run_id, active_run_started_at)
         VALUES ($1, $2, NULL, $3, $4, $5)
         ON CONFLICT (object_type_id) DO UPDATE SET
           status        = EXCLUDED.status,
           error_message = NULL,
           environment_id = COALESCE(EXCLUDED.environment_id, funnel_state.environment_id),
           active_run_id = COALESCE(EXCLUDED.active_run_id, funnel_state.active_run_id),
           active_run_started_at = COALESCE(EXCLUDED.active_run_started_at, funnel_state.active_run_started_at),
           updated_at    = now()`,
        [
          objectTypeId,
          status,
          options.environmentId ?? null,
          run?.runId ?? null,
          run?.startedAt ?? null,
        ]
      );
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    }

    // Live update: broadcast `funnel_state.changed` to every connected
    // WebSocket client.
    try {
      eventBus.emit("ws:event", {
        event: "funnel_state.changed",
        projectId: null,
        payload: {
          ontologyId,
          objectTypeId,
          objectTypeApiName,
          status,
          objectsIndexed: status === "indexed" ? runObjects : undefined,
          lastIndexedAt: lastIndexedAtIso,
          errorMessage: errorMessageForEmit,
          environmentId: options.environmentId ?? null,
          path,
          emittedAt: new Date().toISOString(),
        },
      });
    } catch (emitErr) {
      console.warn(
        JSON.stringify({
          level: "warn",
          type: "funnel_state_emit_failed",
          ontologyId,
          objectTypeApiName,
          status,
          error: (emitErr as Error).message,
        }),
      );
    }
  } catch (err) {
    // Cross-environment + terminal-consistency violations are FAILURE
    // SIGNALS, not observability noise — rethrow so the workflow lands in
    // 'failed'. Plain DB errors are still logged + metricated; callers
    // with fail-closed requirements (workflow terminal activity) catch
    // and surface them as the run's failure message.
    const isConsistencyError =
      err instanceof FunnelExecutionEnvironmentMismatch ||
      err instanceof FunnelStaleStateTransition ||
      err instanceof UnknownFunnelDefinitionError;
    const errorClass =
      err instanceof Error ? err.constructor.name : "unknown";
    funnelProjectionTotal.inc({ status, outcome: "db_error", path });
    funnelProjectionFailuresTotal.inc({
      status,
      path,
      error_class: errorClass,
    });
    observeDuration("db_error");
    console.warn(
      JSON.stringify({
        level: isConsistencyError ? "error" : "warn",
        type: isConsistencyError
          ? "funnel_projection_consistency_violation"
          : "funnel_projection_failed",
        ontologyId,
        objectTypeApiName,
        status,
        path,
        error: (err as Error).message,
        errorClass,
      }),
    );
    if (isConsistencyError) throw err;
  }
}

// ---------------------------------------------------------------------------
// Stale "Indexing" reconciliation gauge probe — FUNN-ISO-6
//
// Returns funnel_state rows that have been in 'indexing' longer than the
// threshold; the reconciliation loop flags them and records the metric.
// ---------------------------------------------------------------------------
export async function findStaleIndexingStates(
  thresholdMs: number
): Promise<Array<{ object_type_id: string; updated_at: Date; api_name: string }>> {
  const res = await query(
    `SELECT fs.object_type_id, fs.updated_at, ot.api_name
       FROM funnel_state fs
       LEFT JOIN object_type ot ON ot.object_type_id = fs.object_type_id
      WHERE fs.status = 'indexing'
        AND fs.updated_at < now() - $1::interval`,
    [`${Math.ceil(thresholdMs / 1000)} seconds`],
  );
  return res.rows;
}
