// ---------------------------------------------------------------------------
// Indexing Routes — Express Router
//
// Routes for triggering and monitoring the OpenSearch indexing pipeline.
// Mounted at:
//   /api/v1/ontologies/:ontologyId/objectTypes/:apiName/index
//
// Task 14: POST /           — Trigger a full reindex
// Task 15: GET  /status     — Get indexing status
// Task 16: DELETE /         — Delete the OpenSearch index
//
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { indexObjectType } from "../services/indexing/indexingOrchestrator";
import { getState, setState } from "../models/funnelState";
import {
  getIndexStats,
  getIndexName,
  deleteIndex,
} from "../services/opensearch/indexLifecycleManager";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import type { PipelineFailure } from "../services/indexing/indexingOrchestrator";

const router = Router({ mergeParams: true });

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
// Helper: check if a backing datasource is registered
// ---------------------------------------------------------------------------

async function hasDatasource(objectTypeId: string): Promise<boolean> {
  const result = await query(
    "SELECT mapping_id FROM backing_datasource WHERE object_type_id = $1",
    [objectTypeId]
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Route 1: POST / — Trigger full reindex
//
// Runs the complete 7-stage indexing pipeline synchronously (Week 1).
// For production, this would be an async job with polling.
// ---------------------------------------------------------------------------

router.post(
  "/",
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
      // Validation 3: Backing datasource registered
      // -----------------------------------------------------------------
      if (!(await hasDatasource(objectType.object_type_id))) {
        return sendError(
          res,
          "NO_BACKING_DATASOURCE",
          `Object type '${apiName}' has no backing datasource. Register one first via POST /api/v1/ontologies/${ontologyId}/objectTypes/${apiName}/datasource.`
        );
      }

      // -----------------------------------------------------------------
      // Validation 4: Not already indexing (prevent concurrent runs)
      // -----------------------------------------------------------------
      const pipelineState = await getState(apiName);
      if (pipelineState && pipelineState.status === "running") {
        return sendError(
          res,
          "INDEXING_IN_PROGRESS",
          `Object type '${apiName}' is already being indexed. Wait for the current indexing to complete.`
        );
      }

      // -----------------------------------------------------------------
      // Parse options from request body
      // -----------------------------------------------------------------
      const forceRecreateIndex = req.body?.forceRecreateIndex === true;
      const strict = req.body?.strict !== false; // default true

      // -----------------------------------------------------------------
      // Execute the indexing pipeline
      // -----------------------------------------------------------------
      const result = await indexObjectType(apiName, {
        forceRecreateIndex,
        strict,
      });

      // -----------------------------------------------------------------
      // Handle pipeline result
      // -----------------------------------------------------------------
      if (result.success) {
        return sendSuccess(res, {
          status: "success",
          objectTypeApiName: result.objectTypeApiName,
          indexName: result.indexName,
          objectsIndexed: result.objectsIndexed,
          totalDurationMs: result.totalDurationMs,
          pipeline: result.pipeline,
        });
      }

      // Pipeline returned a structured failure (data validation, etc.)
      const failure = result as PipelineFailure;
      return res.status(400).json({
        status: "failed",
        objectTypeApiName: failure.objectTypeApiName,
        error: {
          code: "DATA_VALIDATION_ERROR",
          message: `Indexing failed at stage ${failure.failedAtStage} (${failure.stageName}): ${failure.error}`,
          details: failure.details ?? {},
        },
      });
    } catch (err: unknown) {
      // Unexpected error — 500 Internal Server Error
      const message = err instanceof Error ? err.message : String(err);

      // Check if it's a known AppError code
      if (err && typeof err === "object" && "code" in err) {
        const appErr = err as { code: string; message: string };
        return sendError(res, appErr.code, appErr.message);
      }

      return res.status(500).json({
        status: "failed",
        objectTypeApiName: apiName,
        error: {
          code: "INDEXING_INTERNAL_ERROR",
          message: "Unexpected error during indexing",
          details: message,
        },
      });
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET /status — Get indexing status
//
// Returns pipeline state, OpenSearch index stats, and datasource info.
// Assembles data from three sources: funnel_pipeline_state table,
// OpenSearch index stats API, and backing_datasource table.
// ---------------------------------------------------------------------------

router.get(
  "/status",
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
      const pipeline = pipelineState
        ? {
            status: pipelineState.status,
            lastIndexedAt: pipelineState.last_indexed_at,
            objectsIndexed: pipelineState.objects_indexed ?? 0,
            durationMs: pipelineState.duration_ms,
            datasourceVersion: pipelineState.datasource_version,
            retryCount: pipelineState.retry_count,
            errorMessage: pipelineState.error_message,
          }
        : {
            status: "idle" as const,
            lastIndexedAt: null,
            objectsIndexed: 0,
            durationMs: null,
            datasourceVersion: null,
            retryCount: 0,
            errorMessage: null,
          };

      // -----------------------------------------------------------------
      // 2. OpenSearch index stats (graceful degradation)
      // -----------------------------------------------------------------
      let index: Record<string, unknown>;
      try {
        const stats = await getIndexStats(apiName);
        if (stats.exists) {
          index = {
            exists: true,
            documentCount: stats.documentCount,
            storeSizeBytes: stats.storeSizeBytes,
            storeSizeHuman: stats.storeSizeHuman,
          };
        } else {
          index = { exists: false };
        }
      } catch {
        // OpenSearch unreachable — degrade gracefully
        index = { exists: false, error: "OpenSearch unreachable" };
      }

      // -----------------------------------------------------------------
      // 3. Backing datasource info
      // -----------------------------------------------------------------
      const dsResult = await query(
        "SELECT file_path, primary_key_column FROM backing_datasource WHERE object_type_id = $1",
        [objectType.object_type_id]
      );

      const datasource =
        dsResult.rows.length > 0
          ? {
              registered: true,
              filePath: dsResult.rows[0].file_path,
              primaryKeyColumn: dsResult.rows[0].primary_key_column,
            }
          : { registered: false };

      // -----------------------------------------------------------------
      // Assemble and return response
      // -----------------------------------------------------------------
      const indexName = getIndexName(apiName);

      return sendSuccess(res, {
        objectTypeApiName: apiName,
        indexName,
        pipeline,
        index,
        datasource,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to retrieve indexing status: ${message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: DELETE / — Delete the OpenSearch index
//
// Deletes all indexed data from OpenSearch for this object type. The object
// type definition in PostgreSQL is NOT affected. Idempotent — deleting a
// non-existent index returns 200 (not an error).
// ---------------------------------------------------------------------------

router.delete(
  "/",
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
      // Validation 3: Not currently indexing
      // -----------------------------------------------------------------
      const pipelineState = await getState(apiName);
      if (pipelineState && pipelineState.status === "running") {
        return sendError(
          res,
          "INDEXING_IN_PROGRESS",
          `Cannot delete index for '${apiName}' while indexing is in progress.`
        );
      }

      // -----------------------------------------------------------------
      // Execute: delete the OpenSearch index
      // -----------------------------------------------------------------
      const indexName = getIndexName(apiName);
      const result = await deleteIndex(apiName);

      // -----------------------------------------------------------------
      // Reset pipeline state to idle
      // -----------------------------------------------------------------
      await setState(apiName, {
        status: "idle",
        objects_indexed: 0,
        error_message: null,
      });

      // -----------------------------------------------------------------
      // Determine response message based on whether index existed
      // -----------------------------------------------------------------
      const indexExisted = !result.message?.includes("does not exist");

      const message = indexExisted
        ? `Index '${indexName}' has been deleted. All indexed objects have been removed. Re-index to restore.`
        : `Index '${indexName}' does not exist, nothing to delete.`;

      return sendSuccess(res, {
        status: "success",
        message,
        objectTypeApiName: apiName,
        indexName,
      });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);

      // Check for known AppError codes
      if (err && typeof err === "object" && "code" in err) {
        const appErr = err as { code: string; message: string };
        return sendError(res, appErr.code, appErr.message);
      }

      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to delete index: ${errMessage}`
      );
    }
  }
);

export default router;
