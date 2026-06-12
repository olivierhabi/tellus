// ---------------------------------------------------------------------------
// Property Routes — Express Router
//
// Routes for Property CRUD, nested under object types:
//   /api/v1/ontology/:ontologyId/objectTypes/:apiName/properties
//
// Also includes primaryKey and titleProperty routes at the object type level.
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import propertyService from "../services/propertyService";
import {
  formatProperty,
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  validateBody,
  CREATE_PROPERTY_SCHEMA,
} from "../middleware/validateBody";
import { validatePropertyLimits } from "../utils/propertyLimits";
import { dataPlaneGuard } from "../middleware/requireRole";

const router = Router({ mergeParams: true });

// Function-level authorization: property create/update require
// ontology-editor, delete requires ontology-admin (PATs scope-gated upstream,
// superadmin passes, reads open). All POSTs here are mutations.
router.use(dataPlaneGuard({ post: "write" }));

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "PROPERTY_NOT_FOUND",
  "PROPERTY_ALREADY_EXISTS",
  "OBJECT_TYPE_NOT_FOUND",
  "INVALID_API_NAME",
  "INVALID_BASE_TYPE",
  "VALIDATION_FAILED",
  "INVALID_PARAMETER",
  "REQUIRED_FIELD_MISSING",
  "STRUCT_DEPTH_EXCEEDED",
  "VECTOR_DIMS_EXCEEDED",
  "BREAKING_SCHEMA_CHANGE",
  "MIGRATION_REQUIRED",
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
// Route 0: POST /properties/batch — Batch create multiple properties
// ---------------------------------------------------------------------------

router.post(
  "/properties/batch",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { properties } = req.body;

      // Validate required fields
      if (!Array.isArray(properties) || properties.length === 0) {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "properties must be a non-empty array."
        );
      }

      const rows = await propertyService.batchCreate(objectTypeId, properties);
      const formatted = rows.map((row: any) => formatProperty(row));

      sendCreated(res, { data: formatted });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 1: POST /properties — Create a property
// ---------------------------------------------------------------------------

router.post(
  "/properties",
  validateBody(CREATE_PROPERTY_SCHEMA),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const {
        apiName: propApiName,
        displayName,
        baseType,
        description,
        structSchema,
        isRequired,
        ordinal,
        conditionalFormatting,
        config,
      } = req.body;

      // Spec §2.4 — enforce struct/vector limits before touching storage.
      validatePropertyLimits({ baseType, structSchema, config });

      const row = await propertyService.create(objectTypeId, {
        apiName: propApiName,
        displayName,
        baseType,
        description,
        structSchema,
        isRequired,
        ordinal,
        conditionalFormatting,
      });

      const formatted = formatProperty(row);
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
// Route 2: GET /properties — List all properties
// ---------------------------------------------------------------------------

router.get(
  "/properties",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const rows = await propertyService.listByObjectType(objectTypeId);
      const formatted = rows.map((row: any) => formatProperty(row));

      sendSuccess(res, { data: formatted });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: GET /properties/:propApiName — Get a single property
// ---------------------------------------------------------------------------

router.get(
  "/properties/:propApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const row = await propertyService.getByApiName(
        objectTypeId,
        req.params.propApiName
      );
      const formatted = formatProperty(row);
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
// Route 4: PUT /properties/:propApiName — Update a property
// ---------------------------------------------------------------------------

router.put(
  "/properties/:propApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      // Spec §2.4 — baseType is immutable at runtime. Changing it is a
      // breaking schema change that must go through the migration manager.
      if (req.body && req.body.baseType !== undefined) {
        const current = await propertyService.getByApiName(
          objectTypeId,
          req.params.propApiName
        );
        if (
          (current as Record<string, unknown>).base_type !== req.body.baseType
        ) {
          return sendError(
            res,
            "BREAKING_SCHEMA_CHANGE",
            "Changing baseType is a breaking schema change; use the migration manager.",
            { from: (current as Record<string, unknown>).base_type, to: req.body.baseType }
          );
        }
      }
      validatePropertyLimits({
        baseType: req.body?.baseType,
        structSchema: req.body?.structSchema,
        config: req.body?.config,
      });

      const row = await propertyService.update(
        objectTypeId,
        req.params.propApiName,
        req.body
      );
      const formatted = formatProperty(row);
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
// Route 5: DELETE /properties/:propApiName — Delete a property
// ---------------------------------------------------------------------------

router.delete(
  "/properties/:propApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      await propertyService.delete(objectTypeId, req.params.propApiName);
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
// Route 6: POST /primaryKey — Set the primary key property
// ---------------------------------------------------------------------------

router.post(
  "/primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { propertyApiName } = req.body;
      if (
        !propertyApiName ||
        typeof propertyApiName !== "string" ||
        propertyApiName.trim() === ""
      ) {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "propertyApiName is required."
        );
      }

      await propertyService.setPrimaryKey(objectTypeId, propertyApiName);
      sendSuccess(res, {
        message: `Primary key set to '${propertyApiName}'.`,
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
// Route 7: POST /titleProperty — Set the title property
// ---------------------------------------------------------------------------

router.post(
  "/titleProperty",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { propertyApiName } = req.body;
      if (
        !propertyApiName ||
        typeof propertyApiName !== "string" ||
        propertyApiName.trim() === ""
      ) {
        return sendError(
          res,
          "REQUIRED_FIELD_MISSING",
          "propertyApiName is required."
        );
      }

      await propertyService.setTitleProperty(objectTypeId, propertyApiName);
      sendSuccess(res, {
        message: `Title property set to '${propertyApiName}'.`,
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
