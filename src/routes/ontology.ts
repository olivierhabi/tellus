// ---------------------------------------------------------------------------
// Ontology Routes — Express Router
//
// Handles HTTP requests for Ontology CRUD operations. Validates input, calls
// the ontology service, formats the response, and handles errors.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import ontologyService from "../services/ontologyService";
import {
  formatOntology,
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  validateBody,
  CREATE_ONTOLOGY_SCHEMA,
} from "../middleware/validateBody";
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
// Route 1: POST /api/v1/ontology — Create a new ontology
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/ontology",
  requireOntologyWrite,
  validateBody(CREATE_ONTOLOGY_SCHEMA),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { displayName, description } = req.body;

      const row = await ontologyService.create({
        displayName: displayName.trim(),
        description: description ?? null,
        createdBy: (req as any).user?.id || "system",
      });

      const formatted = formatOntology(row, 0);
      sendCreated(res, formatted);
    } catch (err: any) {
      if (err.code === "ONTOLOGY_ALREADY_EXISTS") {
        return sendError(res, "ONTOLOGY_ALREADY_EXISTS", err.message);
      }
      next(err);
    }
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
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await ontologyService.importOntology(req.body);

      const formatted = formatOntology(result, result.object_type_count);
      sendCreated(res, formatted);
    } catch (err: any) {
      if (
        err.code === "VALIDATION_FAILED" ||
        err.code === "INVALID_API_NAME" ||
        err.code === "INVALID_BASE_TYPE" ||
        err.code === "OBJECT_TYPE_ALREADY_EXISTS"
      ) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
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

      await ontologyService.delete(ontologyId);
      sendNoContent(res);
    } catch (err: any) {
      if (err.code === "ONTOLOGY_NOT_FOUND") {
        return sendError(res, "ONTOLOGY_NOT_FOUND", err.message);
      }
      next(err);
    }
  }
);

export default router;
