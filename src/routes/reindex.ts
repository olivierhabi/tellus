// ---------------------------------------------------------------------------
// Reindex Routes — Express Router
//
// Routes for triggering and monitoring the reindex pipeline. Mounted at:
//   /api/v1/ontology/:ontologyId/objectTypes/:apiName/reindex
//
// Provides endpoints:
//   POST /          — Trigger a full reindex
//   GET  /status    — Get current reindex status
//   GET  /history   — Get paginated reindex history
//
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
//
// Includes:
//   - Smart skip logic: checks if reindex is needed before running
//   - Atomic locking: UPDATE...WHERE...RETURNING to prevent concurrent runs
//   - Error handling with detailed failure information
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { reindexObjectType } from "../services/reindexService";
import {
  sendSuccess,
  sendCreated,
  sendError,
  decodePageToken,
  encodePageToken,
} from "../utils/responseFormatter";
import { requireOntologyAdmin } from "../middleware/requireRole";
import { resolveRequestTenant } from "../utils/requestTenant";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "ONTOLOGY_NOT_FOUND",
  "NO_BACKING_DATASOURCE",
  "REINDEX_IN_PROGRESS",
  "REINDEX_FAILED",
  // Object type exceeds the in-heap merge budget of the datasource reindex
  // path; surfaced as 413 with the funnel as the documented alternative.
  // Without this entry the route would rewrite it into a generic 500 and the
  // remediation text in the message would never reach the operator.
  "REINDEX_TOO_LARGE",
]);

/**
 * Codes thrown by reindexObjectType that carry their OWN HTTP status and must
 * reach the client through sendError (ERROR_CODES mapping) instead of being
 * rewritten into a generic 500 REINDEX_FAILED by the execute-step catch.
 * REINDEX_TOO_LARGE is the datasource merge-budget guard (413): its message
 * names the type, the count and the funnel route as the remediation.
 */
export const PASSTHROUGH_REINDEX_CODES = new Set(["REINDEX_TOO_LARGE"]);

// ---------------------------------------------------------------------------
// Helper: validate ontology exists
// ---------------------------------------------------------------------------

async function ontologyExists(
  ontologyId: string,
  tenant: string,
): Promise<boolean> {
  const result = await query(
    `SELECT ontology_id
       FROM ontology
      WHERE ontology_id = $1 AND tenant_id = $2`,
    [ontologyId, tenant],
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Helper: resolve object type by ontology + apiName
// ---------------------------------------------------------------------------

interface ObjectTypeInfo {
  object_type_id: string;
  api_name: string;
  primary_key_property_id: string | null;
}

async function resolveObjectType(
  ontologyId: string,
  apiName: string,
  tenant: string,
): Promise<ObjectTypeInfo | null> {
  const result = await query(
    `SELECT ot.object_type_id, ot.api_name, ot.primary_key_property_id
       FROM object_type ot
       JOIN ontology o ON o.ontology_id = ot.ontology_id
      WHERE ot.ontology_id = $1
        AND ot.api_name = $2
        AND o.tenant_id = $3`,
    [ontologyId, apiName, tenant]
  );
  return result.rows.length > 0 ? (result.rows[0] as ObjectTypeInfo) : null;
}

// ---------------------------------------------------------------------------
// Helper: check if a backing datasource is registered
// ---------------------------------------------------------------------------

async function getDatasource(
  objectTypeId: string
): Promise<Record<string, unknown> | null> {
  const result = await query(
    `SELECT bs.*, d.dataset_id as ds_dataset_id
     FROM backing_datasource bs
     LEFT JOIN dataset d ON bs.dataset_id = d.dataset_id
     WHERE bs.object_type_id = $1`,
    [objectTypeId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

// ---------------------------------------------------------------------------
// Helper: acquire the per-object-type reindex mutex
// ---------------------------------------------------------------------------

/**
 * How long a `funnel_state.status='indexing'` row may go untouched before
 * `force=true` is allowed to steal it. A live run bumps `updated_at` on every
 * stage transition, so this is a liveness check, not a duration cap: a slow but
 * progressing reindex keeps its lock indefinitely.
 */
function forceStealStaleMs(): number {
  const raw = Number(process.env.REINDEX_FORCE_STEAL_STALE_MS ?? 900_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
}

/**
 * Take the reindex lock for `objectTypeId`, returning false if another run
 * holds it. The claim is a single atomic statement, so concurrent callers
 * cannot both win: `INSERT ... ON CONFLICT DO UPDATE ... WHERE <predicate>`
 * evaluates the predicate against the locked existing row, and the loser gets
 * zero rows back rather than an error.
 *
 * With `allowStealStale` (force mode) the predicate also matches an 'indexing'
 * row that has not been touched for forceStealStaleMs — a lock leaked by a
 * crashed run. See the call site for why force must neither skip this lock nor
 * be blocked by a dead one.
 */
async function claimIndexingLock(
  objectTypeId: string,
  allowStealStale: boolean,
): Promise<boolean> {
  const result = await query(
    `INSERT INTO funnel_state (object_type_id, status, error_message, updated_at, last_progress_at, lease_heartbeat_at)
     VALUES ($1, 'indexing', NULL, now(), now(), now())
     ON CONFLICT (object_type_id) DO UPDATE
       SET status = 'indexing', error_message = NULL, updated_at = now(),
           last_progress_at = now(), lease_heartbeat_at = now()
       WHERE funnel_state.status <> 'indexing'
          OR ($2::boolean AND funnel_state.updated_at < now() - $3::interval)
     RETURNING object_type_id`,
    [objectTypeId, allowStealStale, `${Math.ceil(forceStealStaleMs() / 1000)} seconds`],
  );
  return result.rows.length > 0;
}

/**
 * Release a lock taken by claimIndexingLock when the run never actually
 * started. Scoped to `status='indexing'` so it can never clobber a terminal
 * status written by a run that did start.
 *
 * Without this, the async-pipeline branch below returned its 500 while leaving
 * funnel_state pinned at 'indexing' — the UI showed a perpetual "Indexing…"
 * badge for a run that did not exist, and (before force learned to steal stale
 * locks) nothing short of manual SQL could clear it.
 */
async function releaseIndexingLock(
  objectTypeId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await query(
      `UPDATE funnel_state
          SET status = 'failed', error_message = $1, updated_at = now()
        WHERE object_type_id = $2 AND status = 'indexing'`,
      [errorMessage, objectTypeId],
    );
  } catch (err) {
    // Best-effort: the caller is already returning an error to the client, and
    // the stale-steal path above is the backstop if this write fails.
    console.warn(
      `[reindex] failed to release indexing lock for ${objectTypeId}: ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Detached execution helpers (POST /)
// ---------------------------------------------------------------------------

/** How long POST / waits for the reindex before answering 202. Must stay
 *  under the 5s request budget (requestTimeout.ts). */
export function reindexSyncWaitMs(): number {
  const raw = Number(process.env.REINDEX_SYNC_WAIT_MS ?? 3_000);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 4_000) : 3_000;
}

/** Keep the lock fresh while a detached run works, so force's stale-steal
 *  (forceStealStaleMs) never takes a lock from a live run. */
const REINDEX_LOCK_HEARTBEAT_MS = 60_000;

async function touchIndexingLock(objectTypeId: string): Promise<void> {
  try {
    await query(
      `UPDATE funnel_state SET updated_at = now(), lease_heartbeat_at = now()
        WHERE object_type_id = $1 AND status = 'indexing'`,
      [objectTypeId],
    );
  } catch {
    /* best-effort */
  }
}

/** A completed funnel run with objects ⇒ object_instances is the system of
 *  record for this type and the serving index is rebuilt from it. */
async function isFunnelManaged(ontologyId: string, apiName: string): Promise<boolean> {
  try {
    const r = await query(
      `SELECT 1 FROM funnel_run
        WHERE ontology_id = $1 AND object_type_api_name = $2
          AND status = 'completed' AND objects_indexed > 0
        LIMIT 1`,
      [ontologyId, apiName],
    );
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

/** Stream object_instances into OpenSearch (bounded memory) and record the
 *  terminal funnel_state. Throws when nothing could be indexed. */
export async function rebuildServingIndexFromInstances(
  ontologyId: string,
  apiName: string,
  objectTypeId: string,
): Promise<unknown> {
  const started = Date.now();
  const { syncObjectInstancesToOpenSearch } = await import("../services/opensearch/syncFromInstances");
  const out = await syncObjectInstancesToOpenSearch(apiName, ontologyId);
  if (out.rowsRead > 0 && out.rowsIndexed === 0) {
    throw Object.assign(
      new Error(`OpenSearch rejected all ${out.rowsFailed} document(s) for '${apiName}' (see [os-sync] logs)`),
      { details: { failedAtStep: "sync_opensearch", durationMs: Date.now() - started } },
    );
  }
  await query(
    `UPDATE funnel_state
        SET status = 'indexed', objects_indexed = $2, last_indexed_at = now(),
            last_index_duration_ms = $3,
            error_message = $4, index_name = $5, updated_at = now()
      WHERE object_type_id = $1`,
    [
      objectTypeId,
      out.rowsIndexed,
      Date.now() - started,
      out.rowsFailed > 0 ? `${out.rowsFailed} document(s) failed to index` : null,
      out.indexName,
    ],
  );
  return out;
}

// ---------------------------------------------------------------------------
// Route 1: POST / — Trigger full reindex
//
// Synchronous reindex for week 1. Includes smart skip logic and atomic
// locking to prevent concurrent runs.
// ---------------------------------------------------------------------------

router.post(
  "/",
  requireOntologyAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId } = req.params;
    // Prefer `req.params.apiName` (legacy `/objectTypes/:apiName/reindex`
    // mount). Fall back to `res.locals.apiName` for the UUID mount
    // (`/objectTypeId/:objectTypeId`), where the resolver middleware
    // stashes the name there — `req.params` does not survive Express's
    // layer-boundary reset between middleware and this router.
    const apiName =
      req.params.apiName ?? ((res.locals as { apiName?: string }).apiName ?? "");
    const force = req.query.force === "true" || req.body?.force === true;
    const tenant = resolveRequestTenant(req);

    try {
      // ---------------------------------------------------------------
      // Step 1: Validate ontology
      // ---------------------------------------------------------------
      if (!(await ontologyExists(ontologyId, tenant))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      // ---------------------------------------------------------------
      // Step 2: Validate object type
      // ---------------------------------------------------------------
      const objectType = await resolveObjectType(ontologyId, apiName, tenant);
      if (!objectType) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${apiName}' not found in ontology '${ontologyId}'.`
        );
      }

      // ---------------------------------------------------------------
      // Step 3: Validate backing datasource
      // ---------------------------------------------------------------
      const datasource = await getDatasource(objectType.object_type_id);
      if (!datasource) {
        return sendError(
          res,
          "NO_BACKING_DATASOURCE",
          `Object type '${apiName}' has no registered backing datasource. Register one using POST /api/v1/ontology/${ontologyId}/objectTypes/${apiName}/datasource`
        );
      }

      // ---------------------------------------------------------------
      // Step 4: Smart skip logic (if not force)
      // ---------------------------------------------------------------
      if (!force) {
        const needsReindex = await checkReindexNeeded(
          objectType.object_type_id,
          datasource,
          apiName
        );
        if (!needsReindex) {
          return sendSuccess(res, {
            status: "no_changes",
            message: `Object type '${apiName}' is already up to date. No new data or edits to index. Use ?force=true to reindex anyway.`,
          });
        }
      }

      // ---------------------------------------------------------------
      // Step 5: Atomic lock — prevent concurrent reindex
      // ---------------------------------------------------------------
      // `force` bypasses the SMART-SKIP (step 4), not the mutex. It used to
      // bypass both: the force branch did an unconditional
      // `DO UPDATE SET status='indexing'`, so two overlapping Force Reindexes
      // each built a replacement index and each cut the alias over — the
      // second cutover pointing the alias at an index the first one was still
      // filling, then deleting the other's rollback index. Nothing detected it;
      // the loser's documents simply vanished.
      //
      // But force cannot be subject to the naive lock either, or a LEAKED
      // 'indexing' row (crash mid-run, or the 202 path below failing after it
      // took the lock) makes the object type permanently un-reindexable, with
      // Force Reindex — the operator's escape hatch — the one thing that can't
      // clear it. That dead end is almost certainly why force skipped the lock.
      //
      // So both modes take the same CAS, and force additionally may STEAL a
      // lock whose heartbeat has gone stale. A live run refreshes
      // funnel_state.updated_at on every stage transition, so "not touched for
      // FORCE_STEAL_STALE_MS" means the holder is gone, not slow.
      if (!(await claimIndexingLock(objectType.object_type_id, force))) {
        // Enriched conflict: say what holds the lock, what stage its run is
        // in, and when either was last heard from — a bare "in progress" is
        // indistinguishable from a wedged run. Best-effort: a failed read
        // must not mask the 409 itself.
        let detail = "";
        try {
          const { describeIndexingLock } = await import(
            "../services/funnel/indexingLease"
          );
          const lock = await describeIndexingLock(
            objectType.object_type_id,
          );
          if (lock) {
            const age = lock.updatedAt
              ? ` (lock touched ${lock.updatedAt})`
              : "";
            const run = lock.activeRunId
              ? ` run ${lock.activeRunId} stage=${lock.runStage ?? "?"} ` +
                `started=${lock.runStartedAt ?? "?"}`
              : " no live run row";
            detail =
              ` Lock: status=${lock.status} indexed=${lock.objectsIndexed}` +
              `${age}.${run}.`;
          }
        } catch {
          /* keep the generic message */
        }
        return sendError(
          res,
          "REINDEX_IN_PROGRESS",
          (force
            ? `A reindex for object type '${apiName}' is already in progress and ` +
              `is still making progress. Force cannot interrupt a live run; ` +
              `wait for it to finish or fail.`
            : `A reindex for object type '${apiName}' is already in progress. Please wait for it to complete.`) +
            detail,
          {},
        );
      }

      // ---------------------------------------------------------------
      // Step 6: Execute reindex
      // ---------------------------------------------------------------
      // Force ⇒ the next funnel indexing pass is FULL (Palantir: a user-
      // triggered reindex). Dropping the watermark makes incremental
      // indexing impossible until a full pass re-establishes it.
      if (force) {
        try {
          const { clearIndexWatermark } = await import("../services/funnel/indexingPlan");
          await clearIndexWatermark(ontologyId, apiName);
        } catch (err: any) {
          console.warn(`[reindex] ${apiName}: clearing index watermark failed: ${err.message}`);
        }
      }
      // Phase 5 cutover (feature flag FUNNEL_OPENSEARCH_PIPELINE=1):
      // route CSV backings through the async, bounded-memory, checkpointed,
      // resumable OpenSearch pipeline instead of the synchronous
      // reindexObjectType. Returns 202 + run_id immediately. CSV-only —
      // non-CSV (Iceberg/Parquet) backings stay on reindexObjectType / the
      // funnel dispatcher (do not set the flag for those).
      if (process.env.FUNNEL_OPENSEARCH_PIPELINE === "1") {
        try {
          const { startOsReindexRun } = await import(
            "../services/indexing/osReindexRun"
          );
          const runId = await startOsReindexRun(
            ontologyId,
            apiName,
            force ? "force" : "manual",
          );
          return res.status(202).json({
            success: true,
            data: {
              status: "accepted",
              runId,
              objectType: apiName,
              pipeline: "opensearch-async",
            },
          });
        } catch (err: any) {
          // The lock was taken in step 5 but no run exists to release it —
          // hand it back, or funnel_state stays pinned at 'indexing' forever.
          await releaseIndexingLock(
            objectType.object_type_id,
            `Failed to start async reindex: ${err.message}`,
          );
          return sendError(
            res,
            "REINDEX_FAILED",
            `Failed to start async reindex: ${err.message}`,
            {},
          );
        }
      }

      // A full reindex of a large type takes minutes (6.35M rows ≈ 12 min),
      // far past the 5s data-plane request budget — the client got a 504
      // while the work kept running unobserved. Run it detached: answer with
      // the real result if it finishes within the sync window (small types,
      // fast failures), otherwise 202 + the status URL to poll.
      //
      // Funnel-managed types (a completed funnel run populated
      // object_instances) rebuild the serving index by streaming
      // object_instances — the same bounded-memory sync the funnel uses —
      // instead of the legacy datasource path, which merges in heap and
      // refuses > REINDEX_MAX_MERGED_OBJECTS rows (REINDEX_TOO_LARGE).
      const funnelManaged = await isFunnelManaged(ontologyId, apiName);
      const objectTypeId = objectType.object_type_id as string;
      const heartbeat = setInterval(() => {
        void touchIndexingLock(objectTypeId);
      }, REINDEX_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      const run: Promise<unknown> = (
        funnelManaged
          ? rebuildServingIndexFromInstances(ontologyId, apiName, objectTypeId)
          : reindexObjectType(ontologyId, apiName)
      ).finally(() => clearInterval(heartbeat));

      type Outcome = { kind: "ok"; result: unknown } | { kind: "err"; err: any } | { kind: "pending" };
      let waitTimer: NodeJS.Timeout | undefined;
      const outcome: Outcome = await Promise.race([
        run.then(
          (result): Outcome => ({ kind: "ok", result }),
          (err): Outcome => ({ kind: "err", err }),
        ),
        new Promise<Outcome>((resolve) => {
          waitTimer = setTimeout(() => resolve({ kind: "pending" }), reindexSyncWaitMs());
        }),
      ]);
      clearTimeout(waitTimer);

      if (outcome.kind === "pending") {
        run.then(
          () => console.log(`[reindex] ${apiName}: background reindex completed`),
          async (err: any) => {
            console.error(`[reindex] ${apiName}: background reindex failed: ${err?.message ?? err}`);
            await releaseIndexingLock(objectTypeId, String(err?.message ?? err));
          },
        );
        return res.status(202).json({
          success: true,
          data: {
            status: "accepted",
            objectType: apiName,
            pipeline: funnelManaged ? "opensearch-from-instances" : "datasource-reindex",
            statusUrl: `${req.baseUrl}/status`,
          },
        });
      }

      if (outcome.kind === "ok") {
        // Step 7: Success response
        return sendSuccess(res, {
          status: "completed",
          objectType: apiName,
          result: outcome.result,
        });
      }

      {
        const err = outcome.err;
        // Step 8: Failure response
        const durationMs = err.details?.durationMs || 0;
        const failedAtStep = err.details?.failedAtStep || "unknown";

        // Ensure funnel_state is reset from 'indexing' on failure
        // (reindexService should handle this, but be defensive)
        await releaseIndexingLock(objectTypeId, err.message);

        // Status-carrying guard errors (e.g. REINDEX_TOO_LARGE → 413) keep
        // their mapped status — never collapse them into a 500.
        if (err.code && PASSTHROUGH_REINDEX_CODES.has(err.code)) {
          return sendError(res, err.code, err.message, {
            objectType: apiName,
            durationMs,
            failedAtStep,
          });
        }

        return res.status(500).json({
          error: "REINDEX_FAILED",
          message: `Reindex failed for object type '${apiName}': ${err.message}`,
          details: {
            objectType: apiName,
            durationMs,
            failedAtStep,
          },
        });
      }
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET /status — Get current reindex status
//
// Returns the current funnel state, latest reindex history entry, and
// OpenSearch index info for the object type.
// ---------------------------------------------------------------------------

router.get(
  "/status",
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId } = req.params;
    // See POST / above for why we also accept `res.locals.apiName`.
    const apiName =
      req.params.apiName ?? ((res.locals as { apiName?: string }).apiName ?? "");
    const tenant = resolveRequestTenant(req);

    try {
      // Validation
      if (!(await ontologyExists(ontologyId, tenant))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      const objectType = await resolveObjectType(ontologyId, apiName, tenant);
      if (!objectType) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${apiName}' not found in ontology '${ontologyId}'.`
        );
      }

      // Fetch funnel state
      const fsResult = await query(
        "SELECT * FROM funnel_state WHERE object_type_id = $1",
        [objectType.object_type_id]
      );
      const funnelState = fsResult.rows[0] || null;

      // Fetch funnel pipeline state
      const fpsResult = await query(
        "SELECT * FROM funnel_pipeline_state WHERE object_type_api_name = $1",
        [apiName]
      );
      const pipelineState = fpsResult.rows[0] || null;

      // Fetch latest reindex history
      const histResult = await query(
        `SELECT * FROM reindex_history
         WHERE object_type_api_name = $1
         ORDER BY started_at DESC
         LIMIT 1`,
        [apiName]
      );
      const lastReindex = histResult.rows[0] || null;

      // Fetch pending edits count
      const editsResult = await query(
        `SELECT COUNT(*) as count FROM ontology_edit
         WHERE object_type_api_name = $1 AND indexed = false`,
        [apiName]
      );
      const pendingEdits = parseInt(editsResult.rows[0].count, 10);

      // Fetch datasource info
      const datasource = await getDatasource(objectType.object_type_id);

      // Count committed transactions if dataset-backed
      let transactionCount = 0;
      if (datasource?.dataset_id) {
        const txnCountResult = await query(
          `SELECT COUNT(*) as count FROM dataset_transaction
           WHERE dataset_id = $1 AND status = 'committed'`,
          [datasource.dataset_id]
        );
        transactionCount = parseInt(txnCountResult.rows[0].count, 10);
      }

      sendSuccess(res, {
        objectType: apiName,
        funnelState: funnelState
          ? {
              status: funnelState.status,
              objectsIndexed: funnelState.objects_indexed || 0,
              lastIndexedAt: funnelState.last_indexed_at || null,
              lastIndexDurationMs:
                funnelState.last_index_duration_ms || null,
              errorMessage: funnelState.error_message || null,
              indexName: funnelState.index_name || null,
            }
          : null,
        pipelineState: pipelineState
          ? {
              status: pipelineState.status,
              // Live 4-stage funnel pipeline tracking (spec §1.7 item 47):
              //   changelog → merge_changes → indexing → hydration
              // Null means no stage is currently running.
              currentStage: pipelineState.current_stage || null,
              stageStartedAt: pipelineState.stage_started_at || null,
              objectsIndexed: pipelineState.objects_indexed || 0,
              lastIndexedAt: pipelineState.last_indexed_at || null,
              durationMs: pipelineState.duration_ms || null,
              errorMessage: pipelineState.error_message || null,
              retryCount: pipelineState.retry_count || 0,
            }
          : null,
        lastReindex: lastReindex
          ? {
              reindexId: lastReindex.reindex_id,
              status: lastReindex.status,
              startedAt: lastReindex.started_at,
              completedAt: lastReindex.completed_at,
              durationMs: lastReindex.duration_ms,
              transactionsProcessed:
                lastReindex.transactions_processed,
              objectsFromDatasource:
                lastReindex.objects_from_datasource,
              editsApplied: lastReindex.edits_applied,
              totalObjectsIndexed:
                lastReindex.total_objects_indexed,
              errorMessage: lastReindex.error_message,
            }
          : null,
        pendingEdits,
        datasource: datasource
          ? {
              registered: true,
              datasetId: datasource.dataset_id || null,
              filePath: datasource.file_path,
              primaryKeyColumn: datasource.primary_key_column,
              transactionCount,
            }
          : { registered: false },
      });
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: GET /history — Paginated reindex history
//
// Returns a paginated list of all reindex operations for the object type,
// newest first. Supports cursor-based pagination.
// ---------------------------------------------------------------------------

router.get(
  "/history",
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId } = req.params;
    // See POST / above for why we also accept `res.locals.apiName`.
    const apiName =
      req.params.apiName ?? ((res.locals as { apiName?: string }).apiName ?? "");
    const tenant = resolveRequestTenant(req);

    try {
      // Validation
      if (!(await ontologyExists(ontologyId, tenant))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      const objectType = await resolveObjectType(ontologyId, apiName, tenant);
      if (!objectType) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${apiName}' not found in ontology '${ontologyId}'.`
        );
      }

      // Parse pagination
      const pageSize = Math.min(
        parseInt(String(req.query.pageSize || "20"), 10),
        100
      );
      let offset = 0;
      if (req.query.pageToken) {
        try {
          offset = decodePageToken(String(req.query.pageToken));
        } catch {
          return sendError(
            res,
            "INVALID_PARAMETER",
            "Invalid page token."
          );
        }
      }

      // Fetch history with pagination
      const histResult = await query(
        `SELECT * FROM reindex_history
         WHERE object_type_api_name = $1
         ORDER BY started_at DESC
         LIMIT $2 OFFSET $3`,
        [apiName, pageSize + 1, offset]
      );

      const hasMore = histResult.rows.length > pageSize;
      const items = histResult.rows.slice(0, pageSize);

      // Get total count
      const countResult = await query(
        "SELECT COUNT(*) as total FROM reindex_history WHERE object_type_api_name = $1",
        [apiName]
      );
      const totalCount = parseInt(countResult.rows[0].total, 10);

      sendSuccess(res, {
        objectType: apiName,
        history: items.map((h: any) => ({
          reindexId: h.reindex_id,
          status: h.status,
          triggeredBy: h.triggered_by,
          startedAt: h.started_at,
          completedAt: h.completed_at,
          durationMs: h.duration_ms,
          transactionsProcessed: h.transactions_processed,
          objectsFromDatasource: h.objects_from_datasource,
          editsApplied: h.edits_applied,
          totalObjectsIndexed: h.total_objects_indexed,
          errorMessage: h.error_message,
          metadata: h.metadata,
        })),
        totalCount,
        nextPageToken: hasMore
          ? encodePageToken(offset + pageSize)
          : null,
      });
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Helper: check if reindex is needed
//
// Returns true if there are new transactions or unindexed edits since the
// last reindex.
// ---------------------------------------------------------------------------

async function checkReindexNeeded(
  objectTypeId: string,
  datasource: Record<string, unknown>,
  apiName: string
): Promise<boolean> {
  // Check for unindexed edits
  const editsResult = await query(
    `SELECT COUNT(*) as count FROM ontology_edit
     WHERE object_type_api_name = $1 AND indexed = false`,
    [apiName]
  );
  if (parseInt(editsResult.rows[0].count, 10) > 0) {
    return true;
  }

  // Check funnel_state — if never indexed, needs reindex
  const fsResult = await query(
    "SELECT status, last_indexed_at FROM funnel_state WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (fsResult.rows.length === 0) {
    return true;
  }
  const funnelState = fsResult.rows[0];
  if (
    funnelState.status === "not_indexed" ||
    funnelState.status === "stale" ||
    funnelState.status === "failed"
  ) {
    return true;
  }
  if (!funnelState.last_indexed_at) {
    return true;
  }

  // If dataset-backed, check for new committed transactions since last index
  if (datasource.dataset_id) {
    const txnResult = await query(
      `SELECT COUNT(*) as count FROM dataset_transaction
       WHERE dataset_id = $1 AND status = 'committed'
         AND committed_at > $2`,
      [datasource.dataset_id, funnelState.last_indexed_at]
    );
    if (parseInt(txnResult.rows[0].count, 10) > 0) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Error code registrations for responseFormatter
//
// These are handled by the KNOWN_CODES set and the route-level catch blocks.
// ---------------------------------------------------------------------------
//
// REINDEX_IN_PROGRESS → 409
// REINDEX_FAILED      → 500
// NO_BACKING_DATASOURCE → 400
// REINDEX_TOO_LARGE   → 413
//

export default router;
