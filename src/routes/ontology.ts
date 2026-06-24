// ---------------------------------------------------------------------------
// Ontology Routes — Express Router
//
// Handles HTTP requests for Ontology CRUD operations. Validates input, calls
// the ontology service, formats the response, and handles errors.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import objectTypeService from "../services/objectTypeService";
import ontologyService from "../services/ontologyService";
import {
  formatOntology,
  sendSuccess,
  sendError,
} from "../utils/responseFormatter";
import { requireOntologyWrite, requireOntologyAdmin } from "../middleware/requireRole";

const router = Router();

// NOTE: this router is mounted at ROOT (`app.use(ontologyRouter)`) and its
// routes carry FULL paths (`/api/v1/ontology...`). A router-level
// `router.use(dataPlaneGuard())` here would therefore run on EVERY request in
// the chain (e.g. POST /api/v1/auth/login) and wrongly reject it. So we gate
// each mutating route INDIVIDUALLY below instead of router-wide.

// ---------------------------------------------------------------------------
// UUID format validation regex
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// "One Enterprise, One Ontology" — the deployment has exactly one ontology,
// bootstrapped by migration and protected by a DB singleton guard. The
// lifecycle endpoints that would create or destroy an ontology are frozen and
// return 409 ONTOLOGY_SINGLETON. Read + metadata-update endpoints stay live.
// ---------------------------------------------------------------------------

const SINGLETON_MESSAGE =
  "This deployment uses a single enterprise ontology (One Enterprise, One Ontology). " +
  "Ontologies cannot be created, imported, or deleted.";

// ---------------------------------------------------------------------------
// Route 1: POST /api/v1/ontology — FROZEN (no new ontologies)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/ontology",
  requireOntologyWrite,
  async (_req: Request, res: Response) => {
    sendError(res, "ONTOLOGY_SINGLETON", SINGLETON_MESSAGE);
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET /api/v1/ontology — List all ontologies with pagination
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/ontology",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawPageSize = req.query.pageSize;
      const pageSize = rawPageSize
        ? Math.min(Math.max(parseInt(rawPageSize as string, 10) || 100, 1), 1000)
        : 100;
      const pageToken = (req.query.pageToken as string) || null;

      const result = await ontologyService.list({ pageSize, pageToken });

      const formatted = result.data.map((row: any) =>
        formatOntology(row, row.object_type_count)
      );

      sendSuccess(res, {
        data: formatted,
        totalCount: result.totalCount,
        pageSize: result.pageSize,
        nextPageToken: result.nextPageToken,
      });
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: POST /api/v1/ontology/import — Import an ontology from JSON
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/ontology/import",
  requireOntologyWrite,
  async (_req: Request, res: Response) => {
    sendError(res, "ONTOLOGY_SINGLETON", SINGLETON_MESSAGE);
  }
);

// ---------------------------------------------------------------------------
// Route 4: GET /api/v1/ontology/:ontologyId/export — Export full ontology
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/ontology/:ontologyId/export",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;

      if (!UUID_RE.test(ontologyId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "ontologyId must be a valid UUID."
        );
      }

      const exportData = await ontologyService.exportOntology(ontologyId);

      // Build Content-Disposition filename: kebab-case display name + date
      const displayName = exportData.ontology.displayName;
      const kebab = displayName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `${kebab}-export-${dateStr}.json`;

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      sendSuccess(res, exportData);
    } catch (err: any) {
      if (err.code === "ONTOLOGY_NOT_FOUND") {
        return sendError(res, "ONTOLOGY_NOT_FOUND", err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: GET /api/v1/ontology/:ontologyId — Get a single ontology
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/ontology/:ontologyId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;

      if (!UUID_RE.test(ontologyId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "ontologyId must be a valid UUID."
        );
      }

      const result = await ontologyService.getById(ontologyId);
      const formatted = formatOntology(result, result.object_type_count);
      sendSuccess(res, formatted);
    } catch (err: any) {
      if (err.code === "ONTOLOGY_NOT_FOUND") {
        return sendError(res, "ONTOLOGY_NOT_FOUND", err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 4: PUT /api/v1/ontology/:ontologyId — Update an ontology
// ---------------------------------------------------------------------------

router.put(
  "/api/v1/ontology/:ontologyId",
  requireOntologyWrite,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;

      if (!UUID_RE.test(ontologyId)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "ontologyId must be a valid UUID."
        );
      }

      const { displayName, description } = req.body;

      if (displayName === undefined && description === undefined) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "At least one field (displayName or description) must be provided."
        );
      }

      const updateInput: { displayName?: string; description?: string | null } = {};
      if (displayName !== undefined) updateInput.displayName = displayName;
      if (description !== undefined) updateInput.description = description;

      const result = await ontologyService.update(ontologyId, updateInput);
      const formatted = formatOntology(result, 0);
      sendSuccess(res, formatted);
    } catch (err: any) {
      if (err.code === "ONTOLOGY_NOT_FOUND") {
        return sendError(res, "ONTOLOGY_NOT_FOUND", err.message);
      }
      if (err.code === "ONTOLOGY_ALREADY_EXISTS") {
        return sendError(res, "ONTOLOGY_ALREADY_EXISTS", err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: DELETE /api/v1/ontology/:ontologyId — Delete an ontology
// ---------------------------------------------------------------------------

router.delete(
  "/api/v1/ontology/:ontologyId",
  requireOntologyAdmin,
  async (_req: Request, res: Response) => {
    // The single enterprise ontology cannot be deleted.
    sendError(res, "ONTOLOGY_SINGLETON", SINGLETON_MESSAGE);
  }
);

// ---------------------------------------------------------------------------
// Route 6a: GET /api/v1/ontology/object-types/:objectTypeRid/datasources
// List the backing datasources attached to an Object Type.
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/ontology/object-types/:objectTypeRid/datasources",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeRid } = req.params;
      const datasources = await objectTypeService.listDatasources(objectTypeRid);
      sendSuccess(res, { data: datasources });
    } catch (err: any) {
      if (err.code === "OBJECT_TYPE_NOT_FOUND") {
        return sendError(res, "OBJECT_TYPE_NOT_FOUND", err.message, { statusCode: 404 });
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 6: POST /api/v1/ontology/object-types/:objectTypeRid/datasources
// Append a backing data source to an existing Object Type.
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/ontology/object-types/:objectTypeRid/datasources",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeRid } = req.params;
      const {
        datasourceRid,
        primaryKeyMapping,
        propertyMappings,
        resolutionStrategy,
        conflictPolicy,
      } = req.body;

      if (!datasourceRid || !primaryKeyMapping || !propertyMappings) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "datasourceRid, primaryKeyMapping, and propertyMappings are required.",
          { statusCode: 422 }
        );
      }

      const ifMatch = req.header("If-Match");

      const result = await objectTypeService.addDatasource(objectTypeRid, {
        datasourceRid,
        primaryKeyMapping,
        propertyMappings,
        resolutionStrategy,
        conflictPolicy,
        ifMatch,
      });

      sendSuccess(res, result);
    } catch (err: any) {
      if (err.code === "OBJECT_TYPE_NOT_FOUND" || err.code === "DATASET_NOT_FOUND") {
        return sendError(res, err.code, err.message, { statusCode: 404 });
      }
      if (
        err.code === "CONCURRENT_EDIT_CONFLICT" ||
        err.code === "DATASOURCE_ALREADY_REGISTERED" ||
        err.code === "DATASET_ALREADY_BACKING"
      ) {
        return sendError(res, err.code, err.message, { statusCode: 409 });
      }
      if (err.code === "PRECONDITION_REQUIRED") {
        return sendError(res, "PRECONDITION_REQUIRED", err.message, { statusCode: 428 });
      }
      // Validation errors from the column-mapping / foundry-bridge path.
      if (
        err.code === "VALIDATION_FAILED" ||
        err.code === "COLUMN_MAPPING_INVALID" ||
        err.code === "COLUMN_NOT_FOUND" ||
        err.code === "PRIMARY_KEY_MISMATCH" ||
        err.code === "DATASET_EMPTY" ||
        err.code === "AMBIGUOUS_DATASOURCE"
      ) {
        return sendError(res, err.code, err.message, { statusCode: 422 });
      }
      next(err);
    }
  }
);

export default router;
