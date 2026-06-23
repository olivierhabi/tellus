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
]);

// ---------------------------------------------------------------------------
// Helper: validate ontology exists
// ---------------------------------------------------------------------------

async function ontologyExists(ontologyId: string): Promise<boolean> {
  const result = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
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
  apiName: string
): Promise<ObjectTypeInfo | null> {
  const result = await query(
    `SELECT object_type_id, api_name, primary_key_property_id
     FROM object_type
     WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, apiName]
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
// Route 1: POST / — Trigger full reindex
//
// Synchronous reindex for week 1. Includes smart skip logic and atomic
// locking to prevent concurrent runs.
// ---------------------------------------------------------------------------

router.post(
  "/",
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

    try {
      // ---------------------------------------------------------------
      // Step 1: Validate ontology
      // ---------------------------------------------------------------
      if (!(await ontologyExists(ontologyId))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      // ---------------------------------------------------------------
      // Step 2: Validate object type
      // ---------------------------------------------------------------
      const objectType = await resolveObjectType(ontologyId, apiName);
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
      // Step 5: Atomic lock — prevent concurrent reindex (unless force)
      // ---------------------------------------------------------------
      if (!force) {
        const lockResult = await query(
          `UPDATE funnel_state SET status = 'indexing', error_message = NULL, updated_at = now()
           WHERE object_type_id = $1 AND status != 'indexing'
           RETURNING *`,
          [objectType.object_type_id]
        );

        if (lockResult.rows.length === 0) {
          // Either no row exists or status is already 'indexing'
          const existsResult = await query(
            "SELECT status FROM funnel_state WHERE object_type_id = $1",
            [objectType.object_type_id]
          );

          if (existsResult.rows.length === 0) {
            // No row — create one with 'indexing' status
            const insertResult = await query(
              `INSERT INTO funnel_state (object_type_id, status)
               VALUES ($1, 'indexing')
               ON CONFLICT (object_type_id) DO NOTHING
               RETURNING *`,
              [objectType.object_type_id]
            );
            if (insertResult.rows.length === 0) {
              // Lost the race — another reindex just started
              return sendError(
                res,
                "REINDEX_IN_PROGRESS",
                `A reindex for object type '${apiName}' is already in progress. Please wait for it to complete.`
              );
            }
          } else if (existsResult.rows[0].status === "indexing") {
            return sendError(
              res,
              "REINDEX_IN_PROGRESS",
              `A reindex for object type '${apiName}' is already in progress. Please wait for it to complete.`
            );
          }
        }
      } else {
        // Force mode: ensure funnel_state exists and set to 'indexing'
        await query(
          `INSERT INTO funnel_state (object_type_id, status, error_message)
           VALUES ($1, 'indexing', NULL)
           ON CONFLICT (object_type_id)
           DO UPDATE SET status = 'indexing', error_message = NULL, updated_at = now()`,
          [objectType.object_type_id]
        );
      }

      // ---------------------------------------------------------------
      // Step 6: Execute reindex
      // ---------------------------------------------------------------
      try {
        const result = await reindexObjectType(ontologyId, apiName);

        // Step 7: Success response
        return sendSuccess(res, {
          status: "completed",
          objectType: apiName,
          result,
        });
      } catch (err: any) {
        // Step 8: Failure response
        const durationMs = err.details?.durationMs || 0;
        const failedAtStep = err.details?.failedAtStep || "unknown";

        // Ensure funnel_state is reset from 'indexing' on failure
        // (reindexService should handle this, but be defensive)
        try {
          await query(
            `UPDATE funnel_state SET status = 'failed', error_message = $1, updated_at = now()
             WHERE object_type_id = $2 AND status = 'indexing'`,
            [err.message, objectType.object_type_id]
          );
        } catch {
          // Best-effort
        }

        // If it's a known error, return structured response
        if (err.code && KNOWN_CODES.has(err.code)) {
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

        // Generic error
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

    try {
      // Validation
      if (!(await ontologyExists(ontologyId))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      const objectType = await resolveObjectType(ontologyId, apiName);
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

    try {
      // Validation
      if (!(await ontologyExists(ontologyId))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      const objectType = await resolveObjectType(ontologyId, apiName);
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
//

export default router;
