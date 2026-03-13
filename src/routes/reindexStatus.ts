// ---------------------------------------------------------------------------
// Reindex Status & History Routes
//
// REST API endpoints for monitoring reindex pipeline health and viewing
// historical reindex runs.
//
// Mounted at:
//   /api/v2/ontologies/:ontologyId/objectTypes/:apiName/index
//
// Endpoints:
//   GET /reindex/status   — Current reindex status and health assessment
//   GET /reindex/history  — Paginated reindex history
//
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendError,
  encodePageToken,
  decodePageToken,
} from "../utils/responseFormatter";
import { getState } from "../models/funnelState";
import {
  getIndexStats,
  getIndexName,
} from "../services/opensearch/indexLifecycleManager";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

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
}

async function resolveObjectType(
  ontologyId: string,
  apiName: string
): Promise<ObjectTypeInfo | null> {
  const result = await query(
    "SELECT object_type_id, api_name FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  return result.rows.length > 0 ? (result.rows[0] as ObjectTypeInfo) : null;
}

// ---------------------------------------------------------------------------
// GET /reindex/status — Current reindex status and health assessment
//
// Returns:
//   status:   healthy | stale | failed | never_indexed
//   lastSuccessfulReindex:   timestamp of last successful reindex
//   lastFailedReindex:       timestamp of last failed reindex (if any)
//   pendingEdits:            count of un-indexed edits
//   datasetTransactionsSinceLastIndex: count of new dataset transactions
//   needsReindex:            boolean flag indicating if a reindex is needed
// ---------------------------------------------------------------------------

router.get(
  "/reindex/status",
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId, apiName } = req.params;

    try {
      // -----------------------------------------------------------------
      // Validation 1: Ontology exists
      // -----------------------------------------------------------------
      if (!(await ontologyExists(ontologyId))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      // -----------------------------------------------------------------
      // Validation 2: Object type exists in this ontology
      // -----------------------------------------------------------------
      const objectType = await resolveObjectType(ontologyId, apiName);
      if (!objectType) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${apiName}' not found in ontology '${ontologyId}'.`
        );
      }

      // -----------------------------------------------------------------
      // 1. Pipeline state from funnel_pipeline_state table
      // -----------------------------------------------------------------
      const pipelineState = await getState(apiName);

      // -----------------------------------------------------------------
      // 2. Last successful reindex from reindex_history
      // -----------------------------------------------------------------
      const lastSuccessResult = await query(
        `SELECT started_at, completed_at, duration_ms,
                total_objects_indexed, edits_applied
         FROM reindex_history
         WHERE object_type_api_name = $1 AND status = 'success'
         ORDER BY completed_at DESC
         LIMIT 1`,
        [apiName]
      );
      const lastSuccessfulReindex =
        lastSuccessResult.rows.length > 0
          ? {
              startedAt: lastSuccessResult.rows[0].started_at,
              completedAt: lastSuccessResult.rows[0].completed_at,
              durationMs: lastSuccessResult.rows[0].duration_ms,
              objectsIndexed:
                lastSuccessResult.rows[0].total_objects_indexed,
              editsApplied: lastSuccessResult.rows[0].edits_applied,
            }
          : null;

      // -----------------------------------------------------------------
      // 3. Last failed reindex from reindex_history
      // -----------------------------------------------------------------
      const lastFailedResult = await query(
        `SELECT started_at, completed_at, duration_ms, error_message
         FROM reindex_history
         WHERE object_type_api_name = $1 AND status = 'failed'
         ORDER BY completed_at DESC
         LIMIT 1`,
        [apiName]
      );
      const lastFailedReindex =
        lastFailedResult.rows.length > 0
          ? {
              startedAt: lastFailedResult.rows[0].started_at,
              completedAt: lastFailedResult.rows[0].completed_at,
              durationMs: lastFailedResult.rows[0].duration_ms,
              errorMessage: lastFailedResult.rows[0].error_message,
            }
          : null;

      // -----------------------------------------------------------------
      // 4. Count pending (un-indexed) edits
      // -----------------------------------------------------------------
      const pendingResult = await query(
        `SELECT COUNT(*)::int AS count
         FROM ontology_edit
         WHERE object_type_api_name = $1 AND indexed = false`,
        [apiName]
      );
      const pendingEdits = pendingResult.rows[0].count;

      // -----------------------------------------------------------------
      // 5. Count dataset transactions since last index
      // -----------------------------------------------------------------
      let datasetTransactionsSinceLastIndex = 0;

      // Get the backing datasource's dataset_id if it exists
      const dsResult = await query(
        `SELECT dataset_id
         FROM backing_datasource
         WHERE object_type_id = $1 AND dataset_id IS NOT NULL`,
        [objectType.object_type_id]
      );

      if (dsResult.rows.length > 0) {
        const datasetId = dsResult.rows[0].dataset_id;
        const lastIndexTime =
          pipelineState?.last_indexed_at ||
          lastSuccessfulReindex?.completedAt ||
          null;

        if (lastIndexTime) {
          const txnResult = await query(
            `SELECT COUNT(*)::int AS count
             FROM dataset_transaction
             WHERE dataset_id = $1
               AND status = 'committed'
               AND committed_at > $2`,
            [datasetId, lastIndexTime]
          );
          datasetTransactionsSinceLastIndex = txnResult.rows[0].count;
        } else {
          // Never indexed — count all committed transactions
          const txnResult = await query(
            `SELECT COUNT(*)::int AS count
             FROM dataset_transaction
             WHERE dataset_id = $1 AND status = 'committed'`,
            [datasetId]
          );
          datasetTransactionsSinceLastIndex = txnResult.rows[0].count;
        }
      }

      // -----------------------------------------------------------------
      // 6. Determine health status
      // -----------------------------------------------------------------
      let healthStatus: "healthy" | "stale" | "failed" | "never_indexed";

      if (!pipelineState || pipelineState.status === "idle") {
        // Check if we have any successful reindex in history
        if (lastSuccessfulReindex) {
          // Had a successful reindex before, but pipeline state is idle
          if (pendingEdits > 0 || datasetTransactionsSinceLastIndex > 0) {
            healthStatus = "stale";
          } else {
            healthStatus = "healthy";
          }
        } else {
          healthStatus = "never_indexed";
        }
      } else if (pipelineState.status === "success") {
        if (pendingEdits > 0 || datasetTransactionsSinceLastIndex > 0) {
          healthStatus = "stale";
        } else {
          healthStatus = "healthy";
        }
      } else if (pipelineState.status === "failed") {
        healthStatus = "failed";
      } else if (pipelineState.status === "running") {
        // Currently running — report as healthy (in progress)
        healthStatus = "healthy";
      } else {
        healthStatus = "never_indexed";
      }

      // -----------------------------------------------------------------
      // 7. Determine needsReindex flag
      // -----------------------------------------------------------------
      const needsReindex =
        healthStatus === "stale" ||
        healthStatus === "failed" ||
        healthStatus === "never_indexed";

      // -----------------------------------------------------------------
      // 8. OpenSearch index stats (graceful degradation)
      // -----------------------------------------------------------------
      let indexStats: Record<string, unknown>;
      try {
        const stats = await getIndexStats(apiName);
        if (stats.exists) {
          indexStats = {
            exists: true,
            documentCount: stats.documentCount,
            storeSizeBytes: stats.storeSizeBytes,
            storeSizeHuman: stats.storeSizeHuman,
          };
        } else {
          indexStats = { exists: false };
        }
      } catch {
        indexStats = { exists: false, error: "OpenSearch unreachable" };
      }

      // -----------------------------------------------------------------
      // Return response
      // -----------------------------------------------------------------
      return sendSuccess(res, {
        objectTypeApiName: apiName,
        indexName: getIndexName(apiName),
        status: healthStatus,
        needsReindex,
        pipelineStatus: pipelineState?.status || "idle",
        lastSuccessfulReindex,
        lastFailedReindex,
        pendingEdits,
        datasetTransactionsSinceLastIndex,
        index: indexStats,
        retryCount: pipelineState?.retry_count || 0,
        errorMessage: pipelineState?.error_message || null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to retrieve reindex status: ${message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// GET /reindex/history — Paginated reindex history
//
// Returns full reindex history from the reindex_history table.
// Query parameters:
//   pageSize    — Number of results per page (default 25, max 100)
//   pageToken   — Base64-encoded pagination token
//   status      — Filter by status: success, failed, partial
// ---------------------------------------------------------------------------

router.get(
  "/reindex/history",
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId, apiName } = req.params;

    try {
      // -----------------------------------------------------------------
      // Validation 1: Ontology exists
      // -----------------------------------------------------------------
      if (!(await ontologyExists(ontologyId))) {
        return sendError(
          res,
          "ONTOLOGY_NOT_FOUND",
          `Ontology '${ontologyId}' not found.`
        );
      }

      // -----------------------------------------------------------------
      // Validation 2: Object type exists in this ontology
      // -----------------------------------------------------------------
      const objectType = await resolveObjectType(ontologyId, apiName);
      if (!objectType) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type '${apiName}' not found in ontology '${ontologyId}'.`
        );
      }

      // -----------------------------------------------------------------
      // Parse query parameters
      // -----------------------------------------------------------------
      let pageSize = parseInt(req.query.pageSize as string, 10);
      if (isNaN(pageSize) || pageSize < 1) pageSize = DEFAULT_PAGE_SIZE;
      if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

      let offset: number;
      try {
        offset = decodePageToken(
          (req.query.pageToken as string) || null
        );
      } catch {
        return sendError(
          res,
          "INVALID_PAGE_TOKEN",
          "The provided pageToken is invalid."
        );
      }

      const statusParam = req.query.status as string | undefined;
      if (
        statusParam !== undefined &&
        !["success", "failed", "partial"].includes(statusParam)
      ) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "status must be one of: success, failed, partial."
        );
      }

      // -----------------------------------------------------------------
      // Build query
      // -----------------------------------------------------------------
      const conditions: string[] = ["object_type_api_name = $1"];
      const values: unknown[] = [apiName];
      let paramIndex = 2;

      if (statusParam !== undefined) {
        conditions.push(`status = $${paramIndex}`);
        values.push(statusParam);
        paramIndex++;
      }

      const whereClause = conditions.join(" AND ");

      // Count total matching records
      const countResult = await query(
        `SELECT COUNT(*)::int AS total
         FROM reindex_history
         WHERE ${whereClause}`,
        values
      );
      const totalResults = countResult.rows[0].total;

      // Fetch the page
      const dataResult = await query(
        `SELECT reindex_id, object_type_api_name, status, triggered_by,
                started_at, completed_at, duration_ms,
                transactions_processed, objects_from_datasource,
                edits_applied, total_objects_indexed,
                error_message, metadata
         FROM reindex_history
         WHERE ${whereClause}
         ORDER BY started_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...values, pageSize, offset]
      );

      // -----------------------------------------------------------------
      // Format response
      // -----------------------------------------------------------------
      const history = dataResult.rows.map((row: any) => ({
        reindexId: row.reindex_id,
        objectTypeApiName: row.object_type_api_name,
        status: row.status,
        triggeredBy: row.triggered_by,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        stats: {
          transactionsProcessed: row.transactions_processed,
          objectsFromDatasource: row.objects_from_datasource,
          editsApplied: row.edits_applied,
          totalObjectsIndexed: row.total_objects_indexed,
        },
        errorMessage: row.error_message,
        metadata: row.metadata,
      }));

      const nextOffset = offset + pageSize;
      const nextPageToken =
        nextOffset < totalResults ? encodePageToken(nextOffset) : null;

      return sendSuccess(res, {
        data: history,
        pagination: {
          pageSize,
          totalResults,
          nextPageToken,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to retrieve reindex history: ${message}`
      );
    }
  }
);

export default router;
