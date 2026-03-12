// ---------------------------------------------------------------------------
// Object Type Routes — Express Router
//
// All routes are nested under an ontology:
//   /api/v2/ontologies/:ontologyId/objectTypes
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

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "OBJECT_TYPE_ALREADY_EXISTS",
  "INVALID_API_NAME",
  "VALIDATION_FAILED",
  "ONTOLOGY_NOT_FOUND",
  "INVALID_PARAMETER",
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
          row.index_status || null
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
// Route 4: GET /:apiName — Get a single object type with full details
// ---------------------------------------------------------------------------

router.get(
  "/:apiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;

      const result = await objectTypeService.getByApiName(ontologyId, apiName);

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
      const { displayName, description, icon, iconColor, status } = req.body;

      // At least one field must be provided
      if (
        displayName === undefined &&
        description === undefined &&
        icon === undefined &&
        iconColor === undefined &&
        status === undefined
      ) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "At least one field must be provided for update."
        );
      }

      const updateData: Record<string, unknown> = {};
      if (displayName !== undefined) updateData.displayName = displayName;
      if (description !== undefined) updateData.description = description;
      if (icon !== undefined) updateData.icon = icon;
      if (iconColor !== undefined) updateData.iconColor = iconColor;
      if (status !== undefined) updateData.status = status;

      await objectTypeService.update(ontologyId, apiName, updateData);

      // Re-fetch the full object type for a complete response
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
