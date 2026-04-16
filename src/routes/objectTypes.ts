// ---------------------------------------------------------------------------
// Object Type Routes — Express Router
//
// All routes are nested under an ontology:
//   /api/v1/ontology/:ontologyId/objectTypes
//
// Uses mergeParams: true to access :ontologyId from the parent mount.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import objectTypeService from "../services/objectTypeService";
import {
  formatObjectType,
  formatObjectTypeSummary,
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  validateBody,
  CREATE_OBJECT_TYPE_SCHEMA,
} from "../middleware/validateBody";
import { setEtag, requireIfMatch } from "../middleware/etag";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "OBJECT_TYPE_ALREADY_EXISTS",
  "DUPLICATE_API_NAME",
  "INVALID_API_NAME",
  "VALIDATION_FAILED",
  "ONTOLOGY_NOT_FOUND",
  "INVALID_PARAMETER",
  "CONCURRENT_EDIT_CONFLICT",
  "PRECONDITION_REQUIRED",
  "API_NAME_CONFLICT",
  "BREAKING_SCHEMA_CHANGE",
]);

// ---------------------------------------------------------------------------
// Route 1: POST / — Create a new object type
// ---------------------------------------------------------------------------

router.post(
  "/",
  validateBody(CREATE_OBJECT_TYPE_SCHEMA),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;
      const { apiName, displayName, description, icon, iconColor, status } =
        req.body;

      const row = await objectTypeService.create(ontologyId, {
        apiName,
        displayName,
        description,
        icon,
        iconColor,
        status,
      });

      // New object type has empty properties, no datasource. Fetch the
      // funnel_state row that was created alongside it.
      const full = await objectTypeService.getByApiName(
        ontologyId,
        row.api_name
      );

      const formatted = formatObjectType(
        full.objectType,
        full.properties,
        full.datasource,
        full.funnelState
      );

      const version = Number(
        (full.objectType as Record<string, unknown>).version ?? 1
      );
      setEtag(res, version);
      res.setHeader(
        "Location",
        `/api/v1/ontology/${req.params.ontologyId}/objectTypes/${full.objectType.api_name}`
      );

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
// Route 2: POST /batch — Batch create object type with properties
// ---------------------------------------------------------------------------

router.post(
  "/batch",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;
      const {
        apiName,
        displayName,
        description,
        icon,
        iconColor,
        status,
        onConflict,
        properties,
        primaryKeyProperty,
        titleProperty,
      } = req.body;

      // Validate required fields
      if (!apiName || !displayName) {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "apiName and displayName are required."
        );
      }
      if (!Array.isArray(properties) || properties.length === 0) {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "properties must be a non-empty array."
        );
      }
      if (!primaryKeyProperty) {
        return sendError(
          res,
          "PRIMARY_KEY_NOT_SET",
          "primaryKeyProperty is required for batch creation."
        );
      }

      const result = await objectTypeService.batchCreate(ontologyId, {
        apiName,
        displayName,
        description,
        icon,
        iconColor,
        status,
        onConflict,
        properties,
        primaryKeyProperty,
        titleProperty,
      });

      const formatted = formatObjectType(
        result.objectType,
        result.properties,
        result.datasource,
        result.funnelState
      );

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
// Route 3: POST /:apiName/changeStatus — Change object type status
// ---------------------------------------------------------------------------

router.post(
  "/:apiName/changeStatus",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const { status } = req.body;

      if (!status || typeof status !== "string") {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "status is required (active, experimental, or deprecated)."
        );
      }

      const row = await objectTypeService.changeStatus(
        ontologyId,
        apiName,
        status
      );

      // Re-fetch full object type for complete response
      const full = await objectTypeService.getByApiName(ontologyId, apiName);

      const formatted = formatObjectType(
        full.objectType,
        full.properties,
        full.datasource,
        full.funnelState
      );

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
// Route 4: POST /:apiName/clone — Clone an object type
// ---------------------------------------------------------------------------

router.post(
  "/:apiName/clone",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const { newApiName, newDisplayName } = req.body;

      if (!newApiName || typeof newApiName !== "string") {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "newApiName is required."
        );
      }
      if (!newDisplayName || typeof newDisplayName !== "string") {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "newDisplayName is required."
        );
      }

      const result = await objectTypeService.clone(
        ontologyId,
        apiName,
        newApiName,
        newDisplayName
      );

      const formatted = formatObjectType(
        result.objectType,
        result.properties,
        result.datasource,
        result.funnelState
      );

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
// Route 5: POST /:apiName/export — Export object type definition
// ---------------------------------------------------------------------------

router.get(
  "/:apiName/export",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;

      const exportData = await objectTypeService.exportDefinition(
        ontologyId,
        apiName
      );

      sendSuccess(res, exportData);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 6: POST /import — Import an object type definition
// ---------------------------------------------------------------------------

router.post(
  "/import",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;

      const result = await objectTypeService.importDefinition(
        ontologyId,
        req.body
      );

      const formatted = formatObjectType(
        result.objectType,
        result.properties,
        result.datasource,
        result.funnelState
      );

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
// Route 7: GET / — List object types with pagination
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;
      const rawPageSize = req.query.pageSize;
      const pageSize = rawPageSize
        ? Math.min(
            Math.max(parseInt(rawPageSize as string, 10) || 100, 1),
            1000
          )
        : 100;
      const pageToken = (req.query.pageToken as string) || null;

      const result = await objectTypeService.listByOntology(ontologyId, {
        pageSize,
        pageToken,
      });

      const formatted = result.data.map((row: any) =>
        formatObjectTypeSummary(
          row,
          row.property_count,
          row.datasource_name || null,
          row.index_status || null,
          row.object_count || 0,
          row.dependent_count || 0
        )
      );

      sendSuccess(res, {
        data: formatted,
        totalCount: result.totalCount,
        pageSize: result.pageSize,
        nextPageToken: result.nextPageToken,
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: GET /:apiName/statistics — Get object type summary statistics
// ---------------------------------------------------------------------------

router.get(
  "/:apiName/statistics",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;

      const result = await objectTypeService.getStatistics(
        ontologyId,
        apiName
      );

      sendSuccess(res, result);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3.5: GET /by-id/:objectTypeId — Get a single object type by UUID
//
// Must be declared BEFORE the `/:apiName` route below so that Express's
// first-match routing picks the specific `/by-id/` path for UUID callers
// (the /ontology/[objectTypeId]/overview frontend route) instead of
// hitting the apiName handler.
// ---------------------------------------------------------------------------

router.get(
  "/by-id/:objectTypeId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeId } = req.params;
      const result = await objectTypeService.getById(ontologyId, objectTypeId);
      const version = Number(
        (result.objectType as Record<string, unknown>).version ?? 1
      );
      setEtag(res, version);
      const formatted = formatObjectType(
        result.objectType,
        result.properties,
        result.datasource,
        result.funnelState,
        result.linkTypes
      );
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
// Route 4: GET /:apiName — Get a single object type with full details
// ---------------------------------------------------------------------------

router.get(
  "/:apiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;

      const result = await objectTypeService.getByApiName(ontologyId, apiName);

      const version = Number(
        (result.objectType as Record<string, unknown>).version ?? 1
      );
      setEtag(res, version);

      const formatted = formatObjectType(
        result.objectType,
        result.properties,
        result.datasource,
        result.funnelState,
        result.linkTypes || []
      );

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
// Route 4: PUT /:apiName — Update an object type
// ---------------------------------------------------------------------------

router.put(
  "/:apiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const {
        apiName: newApiName,
        displayName,
        pluralName,
        description,
        aliases,
        pointOfContact,
        contributors,
        visibility,
        editsViaActionsOnly,
        icon,
        iconColor,
        status,
      } = req.body;

      // At least one mutable field must be provided.
      const updatable = {
        apiName: newApiName,
        displayName,
        pluralName,
        description,
        aliases,
        pointOfContact,
        contributors,
        visibility,
        editsViaActionsOnly,
        icon,
        iconColor,
        status,
      };
      if (Object.values(updatable).every((v) => v === undefined)) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "At least one field must be provided for update.",
        );
      }

      // Spec §2.3 optimistic concurrency: check If-Match against current
      // version BEFORE applying any mutations. Missing header is permitted
      // for backward compatibility; stale header is rejected with 409.
      const current = await objectTypeService.getByApiName(ontologyId, apiName);
      const currentVersion = Number(
        (current.objectType as Record<string, unknown>).version ?? 1,
      );
      requireIfMatch(req, currentVersion);

      const updateData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updatable)) {
        if (v !== undefined) updateData[k] = v;
      }

      await objectTypeService.update(ontologyId, apiName, updateData);

      // A successful apiName rename means subsequent reads MUST use the
      // new name — the row the client posted via the old apiName has a
      // different primary lookup key now.
      const effectiveApiName =
        typeof newApiName === "string" && newApiName.length > 0
          ? newApiName
          : apiName;

      // Re-fetch the full object type for a complete response
      const full = await objectTypeService.getByApiName(
        ontologyId,
        effectiveApiName,
      );
      const newVersion = Number(
        (full.objectType as Record<string, unknown>).version ?? currentVersion + 1
      );
      setEtag(res, newVersion);

      const formatted = formatObjectType(
        full.objectType,
        full.properties,
        full.datasource,
        full.funnelState
      );

      sendSuccess(res, formatted);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.parameters || {});
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: DELETE /:apiName — Delete an object type with cascade
// ---------------------------------------------------------------------------

router.delete(
  "/:apiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;

      await objectTypeService.delete(ontologyId, apiName);
      sendNoContent(res);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

export default router;
