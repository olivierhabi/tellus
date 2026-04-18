// ---------------------------------------------------------------------------
// Object-type save-to-ontology + status by ObjectType UUID
//
// Public surface:
//
//   POST /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId
//     — Commit to ontology. Single canonical entrypoint for the
//       "Save to ontology" gesture. Emits the `editBatchPending`
//       funnel signal (durable in Postgres, plus best-effort
//       signal-with-start against Temporal). The async funnel
//       pipeline (changelog → merge → indexing → hydration) picks
//       the signal up from there. Returns 202 Accepted.
//
//   GET  /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId/status
//   GET  /api/v1/ontology/:ontologyId/objectTypeId/:objectTypeId/history
//     — Delegated to the existing `reindexRouter` handlers. Those
//       already read from `funnel_pipeline_state` + `reindex_history`
//       so progress reporting stays coherent with what the funnel
//       pipeline is actually doing.
//
// Why keyed by UUID, not by apiName?
//   The browser route carries `objectTypeId` (a stable surrogate key
//   that survives apiName renames), so the write endpoint follows
//   the same identity. The legacy apiName-keyed routes remain
//   mounted for any other caller; this path is additive.
//
// Why `res.locals.apiName` and not `req.params.apiName`?
//   Express re-creates `req.params` each time it dispatches to a new
//   layer (middleware → sub-router) using the layer's own captured
//   params, which wipes any mutation middleware makes. `res.locals`
//   survives that boundary. The reindex handlers read
//   `req.params.apiName ?? res.locals.apiName`.
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendError, sendSuccess } from "../utils/responseFormatter";
import { sendSignal } from "../services/funnel/durableWorkflow";
import {
  isTemporalConnected,
  signalTemporalWorkflow,
} from "../services/funnel/temporal/worker";

export async function resolveObjectTypeIdToApiName(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { ontologyId, objectTypeId } = req.params as {
    ontologyId?: string;
    objectTypeId?: string;
  };
  if (!ontologyId || !objectTypeId) {
    sendError(
      res,
      "INVALID_PARAMETER",
      "ontologyId and objectTypeId are required."
    );
    return;
  }
  try {
    const result = await query(
      `SELECT api_name FROM object_type
       WHERE ontology_id = $1 AND object_type_id = $2`,
      [ontologyId, objectTypeId]
    );
    if (result.rows.length === 0) {
      sendError(
        res,
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectTypeId}' not found in ontology '${ontologyId}'.`
      );
      return;
    }
    const apiName: string = result.rows[0].api_name;
    // `req.params` mutations don't survive Express's layer-boundary
    // reset when we hand off to `reindexRouter`, so stash on
    // `res.locals` (which does persist). Also write `req.params`
    // defensively for any handler that happens to read it directly.
    (res.locals as Record<string, unknown>).apiName = apiName;
    (req.params as Record<string, string>).apiName = apiName;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST handler — Save to ontology → kick off the async funnel pipeline
//
// Runs AFTER `resolveObjectTypeIdToApiName`, so `res.locals.apiName`
// is populated and `req.params.ontologyId` is the canonical ontology
// UUID. Emits `editBatchPending` via the same `sendSignal` helper used
// by `POST /api/v1/funnel/signals`, then best-effort signal-with-start
// against Temporal. Idempotency + concurrency are handled downstream:
// the PG dispatcher claims signals with `FOR UPDATE SKIP LOCKED`, so
// repeat clicks do not duplicate pipeline runs.
// ---------------------------------------------------------------------------

export async function saveToOntology(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { ontologyId } = req.params as { ontologyId?: string };
  const apiName = (res.locals as { apiName?: string }).apiName;

  if (!ontologyId || !apiName) {
    // Should only happen if the resolver middleware was bypassed.
    sendError(
      res,
      "INTERNAL_ERROR",
      "Object type resolver did not populate ontologyId + apiName."
    );
    return;
  }

  try {
    // 1. Durable Postgres queue — authoritative. If Temporal is down
    //    the dispatcher picks this up on its next poll, so no save is
    //    ever lost regardless of Temporal availability.
    const signalId = await sendSignal({
      ontologyId,
      objectTypeApiName: apiName,
      signalType: "editBatchPending",
    });

    // 2. Best-effort Temporal kick. Already-consumed signals are a
    //    no-op in the dispatcher (see `claimNextSignal`), so double
    //    delivery (PG + Temporal) is safe.
    const temporal = isTemporalConnected()
      ? await signalTemporalWorkflow(
          ontologyId,
          apiName,
          "editBatchPending",
          { signalId }
        )
      : false;

    // Structured log via the `req.log` helper attached by
    // `requestLogger` middleware — rides the per-request requestId
    // so traces can be stitched together downstream. Avoid
    // `console.log`, which produces unstructured output that
    // observability pipelines can't index.
    req.log?.("save_to_ontology_accepted", {
      ontologyId,
      objectTypeApiName: apiName,
      signalId,
      temporal,
    });

    sendSuccess(
      res,
      {
        status: "accepted",
        signalId,
        temporal,
        ontologyId,
        objectTypeApiName: apiName,
      },
      202
    );
  } catch (err) {
    next(err);
  }
}
