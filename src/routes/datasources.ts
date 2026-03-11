// ---------------------------------------------------------------------------
// Datasource Routes — Express Router
//
// Routes for backing datasource management, nested under object types.
// Mounted at:
//   /api/v2/ontologies/:ontologyId/objectTypes/:apiName/datasource
//
// Provides 4 endpoints:
//   POST   /          — Register a backing datasource
//   GET    /          — Get the registered datasource
//   DELETE /          — Unregister the datasource
//   POST   /scan      — Re-scan the file and update metadata
//
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import datasourceService from "../services/datasourceService";
import {
  formatDatasource,
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  validateBody,
  REGISTER_DATASOURCE_SCHEMA,
} from "../middleware/validateBody";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "DATASOURCE_NOT_FOUND",
  "DATASOURCE_ALREADY_REGISTERED",
  "DATASOURCE_FILE_NOT_FOUND",
  "COLUMN_MAPPING_INVALID",
  "PRIMARY_KEY_NOT_SET",
  "VALIDATION_FAILED",
]);

// ---------------------------------------------------------------------------
// Helper: resolve objectTypeId from route params
// ---------------------------------------------------------------------------

async function resolveObjectTypeId(
  req: Request,
  res: Response
): Promise<string | null> {
  const { ontologyId, apiName } = req.params;
  const result = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (result.rows.length === 0) {
    sendError(
      res,
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
    return null;
  }
  return result.rows[0].object_type_id;
}

// ---------------------------------------------------------------------------
// Route 1: POST / — Register a backing datasource
// ---------------------------------------------------------------------------

router.post(
  "/",
  validateBody(REGISTER_DATASOURCE_SCHEMA),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { datasetName, filePath, fileFormat, columnMapping } = req.body;

      const row = await datasourceService.register(objectTypeId, {
        datasetName,
        filePath,
        fileFormat,
        columnMapping,
      });

      const formatted = formatDatasource(row);
      sendCreated(res, formatted);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET / — Get the registered datasource
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const row = await datasourceService.getByObjectType(objectTypeId);
      if (!row) {
        return sendError(
          res,
          "DATASOURCE_NOT_FOUND",
          "No datasource registered for this object type."
        );
      }

      const formatted = formatDatasource(row);
      sendSuccess(res, formatted);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: DELETE / — Unregister the datasource
// ---------------------------------------------------------------------------

router.delete(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      await datasourceService.unregister(objectTypeId);
      sendNoContent(res);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 4: POST /scan — Re-scan the file
// ---------------------------------------------------------------------------

router.post(
  "/scan",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { datasource, schemaChanged } =
        await datasourceService.scan(objectTypeId);

      const formatted = formatDatasource(datasource);
      sendSuccess(res, {
        datasource: formatted,
        schemaChanged,
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

export default router;
