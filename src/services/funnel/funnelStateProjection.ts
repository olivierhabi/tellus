// ---------------------------------------------------------------------------
// Funnel state projection
//
// Bridge from the workflow audit log (`funnel_run`, written by every stage)
// to the UI-facing badge column (`funnel_state.status`, read by
// `objectType.indexingState` and `objectType.object_count`).
//
// Historically the funnel pipeline wrote ONLY to `funnel_run` +
// `funnel_pipeline_state`. The user-facing badge reads `funnel_state.status`,
// which is a separate table populated by:
//   (a) initial OT creation                            → 'not_indexed'
//   (b) the explicit "Reindex" button                  → 'indexing' → 'indexed/failed'
//   (c) datasource registration                        → 'not_indexed'
//
// `Save → editBatchPending` → the funnel pipeline ran successfully but never
// touched `funnel_state`, so the badge stayed at `not_indexed` no matter how
// many times the user clicked Save. This module closes that gap by projecting
// the funnel run's terminal state into `funnel_state` keyed by the OT's UUID.
//
// Extracted from `funnelDispatcher.ts` so the Temporal worker
// (`temporal/activities.ts`) can reuse the exact same projection semantics
// without duplicating SQL, metrics, or WebSocket emission. The PG dispatcher
// (when Temporal is offline) and the Temporal workflow (when connected) both
// call into this single helper, eliminating a class of "indexing-stuck"
// bugs caused by drifted implementations.
//
// Best-effort: any failure here is logged + swallowed. The funnel pipeline
// already succeeded; failing the projection must not retry the whole run.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  funnelProjectionTotal,
  funnelProjectionFailuresTotal,
  funnelProjectionSeconds,
} from "../../metrics/funnelProjection";
import { eventBus } from "../../websocket/eventBus";

export type FunnelStateStatus =
  | "not_indexed"
  | "indexing"
  | "indexed"
  | "failed"
  | "stale";

/**
 * Where in the dispatcher lifecycle this projection is being emitted from.
 *  - `pre`          : PG-dispatcher path, before runWorkflow() is invoked.
 *  - `pre_temporal` : Temporal path, immediately after signalWithStart hand-off.
 *  - `post`         : terminal projection (success / failure) after the
 *                     pipeline finishes.
 * The label is recorded on every metric emission so SRE can disambiguate
 * which path emitted a given projection sample.
 */
export type ProjectionPath = "pre" | "post" | "pre_temporal";

export interface ProjectFunnelTerminalOptions {
  runId?: string;
  errorMessage?: string;
  path?: ProjectionPath;
  /**
   * Explicit objects-indexed count. Used by Temporal which already has the
   * pipeline result in-hand and does not need a DB round-trip to
   * `funnel_run.objects_indexed` to learn the count. When omitted (PG
   * dispatcher), the function falls back to looking up the count by
   * `runId`, which is required for the `indexed` branch.
   */
  objectsIndexed?: number;
}

export async function projectFunnelTerminalToState(
  ontologyId: string,
  objectTypeApiName: string,
  status: FunnelStateStatus,
  options: ProjectFunnelTerminalOptions = {}
): Promise<void> {
  const path = options.path ?? "post";
  const startedAt = Date.now();
  const observeDuration = (outcome: "ok" | "ot_missing" | "db_error") => {
    // Manually observe to keep metrics independent of prom-client's
    // startTimer/stopTimer label-merge semantics, which can throw in
    // edge cases when only a subset of labels is provided up-front.
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
      // OT was renamed/deleted between signal emission and projection.
      // Nothing to update; bail silently — the new OT row, if any,
      // initializes its own funnel_state on creation.
      funnelProjectionTotal.inc({ status, outcome: "ot_missing", path });
      observeDuration("ot_missing");
      return;
    }

    // Track payload deltas across the three success branches so the
    // single live-update emission at the end carries enough context
    // for the FE to merge directly into the React Query cache without
    // a follow-up refetch.
    let runObjects = 0;
    let lastIndexedAtIso: string | null = null;
    let errorMessageForEmit: string | null = null;

    if (status === "indexed") {
      // Two paths to learn the count:
      //   (a) Caller (Temporal) supplied `objectsIndexed` directly. Use it.
      //   (b) Caller (PG dispatcher) supplied a `runId`. Pull the count
      //       from funnel_run.
      // Without either, we record zero — the badge is still authoritative
      // for "indexed at all" vs "still indexing", and the next run will
      // re-stamp with a real count.
      if (typeof options.objectsIndexed === "number") {
        runObjects = Math.max(0, Math.floor(options.objectsIndexed));
      } else if (options.runId) {
        const r = await query(
          `SELECT COALESCE(objects_indexed, 0) AS n
             FROM funnel_run WHERE run_id = $1`,
          [options.runId]
        );
        runObjects = Number(r.rows[0]?.n ?? 0);
      }
      await query(
        `INSERT INTO funnel_state
           (object_type_id, status, objects_indexed, last_indexed_at,
            error_message)
         VALUES ($1, 'indexed', $2, now(), NULL)
         ON CONFLICT (object_type_id) DO UPDATE SET
          status            = 'indexed',
          objects_indexed   = EXCLUDED.objects_indexed,
          last_indexed_at   = now(),
          error_message     = NULL,
          updated_at        = now()`,
        [objectTypeId, runObjects]
      );
      lastIndexedAtIso = new Date().toISOString();
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    } else if (status === "failed") {
      await query(
        `INSERT INTO funnel_state
           (object_type_id, status, error_message)
         VALUES ($1, 'failed', $2)
         ON CONFLICT (object_type_id) DO UPDATE SET
           status        = 'failed',
           error_message = EXCLUDED.error_message,
           updated_at    = now()`,
        [objectTypeId, options.errorMessage ?? null]
      );
      errorMessageForEmit = options.errorMessage ?? null;
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    } else {
      // 'indexing' / 'not_indexed' / 'stale' — clear any prior error so
      // the UI doesn't keep displaying a stale failure copy.
      await query(
        `INSERT INTO funnel_state
           (object_type_id, status, error_message)
         VALUES ($1, $2, NULL)
         ON CONFLICT (object_type_id) DO UPDATE SET
           status        = EXCLUDED.status,
           error_message = NULL,
           updated_at    = now()`,
        [objectTypeId, status]
      );
      funnelProjectionTotal.inc({ status, outcome: "ok", path });
      observeDuration("ok");
    }

    // Live update: broadcast `funnel_state.changed` to every connected
    // WebSocket client. The FE hook (`useObjectTypeById` + listener)
    // merges this directly into the React Query cache, so the UI badge
    // flips with sub-second latency — no polling refetch needed.
    //
    // `projectId: null` means broadcast (see websocket/server.ts:81).
    // We use the same convention as `emitDatasetEvent` from
    // `utils/emitEvent.ts` — same EventBus channel, same shape.
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
          path,
          emittedAt: new Date().toISOString(),
        },
      });
    } catch (emitErr) {
      // Live emission must never fail the projection. If it does, the
      // FE polling baseline (30 s) and explicit invalidations on Save
      // will still converge the badge — just with a small delay.
      // eslint-disable-next-line no-console
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
    // Projection is observability, not core correctness — never fail
    // the funnel run on a projection error. BUT we MUST surface the
    // failure so SRE can alert: a silent projection bug means the
    // page badge stays "Not indexed" forever despite the pipeline
    // having completed successfully — exactly the bug class that
    // motivated this helper.
    const errorClass =
      err instanceof Error ? err.constructor.name : "unknown";
    funnelProjectionTotal.inc({ status, outcome: "db_error", path });
    funnelProjectionFailuresTotal.inc({
      status,
      path,
      error_class: errorClass,
    });
    observeDuration("db_error");
    // Structured warn — the prod log aggregator scrapes these.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "funnel_projection_failed",
        ontologyId,
        objectTypeApiName,
        status,
        path,
        error: (err as Error).message,
        errorClass,
      }),
    );
  }
}
