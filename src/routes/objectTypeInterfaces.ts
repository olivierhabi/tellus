// ---------------------------------------------------------------------------
// Object Type Interface Implementation Routes — Express Router
//
// Endpoints for managing which Interfaces an Object Type implements:
//
//   POST   /api/v2/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements
//   DELETE /api/v2/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements/:interfaceApiName
//   GET    /api/v2/ontology/:ontologyId/objectTypes/:objectTypeApiName/implements
//
// Task 6: "Implements Interface" API
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { appError } from "../utils/appError";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import { validatePropertyMapping } from "../services/interfaceValidator";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "ONTOLOGY_NOT_FOUND",
  "OBJECT_TYPE_NOT_FOUND",
  "INTERFACE_NOT_FOUND",
  "ALREADY_EXISTS",
  "INVALID_PARAMETER",
  "MISSING_REQUIRED_MAPPING",
  "INVALID_MAPPING_KEY",
  "INVALID_MAPPING_VALUE",
  "TYPE_MISMATCH",
  "DUPLICATE_MAPPING_TARGET",
  "NOT_IMPLEMENTED",
  "VALIDATION_FAILED",
]);

// ---------------------------------------------------------------------------
// Helper: resolve ontology, object type, and return their IDs
// ---------------------------------------------------------------------------

async function resolveContext(
  ontologyId: string,
  objectTypeApiName: string
): Promise<{ objectTypeId: string }> {
  // Verify ontology exists
  const ontResult = await query(
    "SELECT ontology_id FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (ontResult.rows.length === 0) {
    throw appError(
      "ONTOLOGY_NOT_FOUND",
      `Ontology '${ontologyId}' not found.`
    );
  }

  // Verify object type exists in this ontology
  const otResult = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, objectTypeApiName]
  );
  if (otResult.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object Type '${objectTypeApiName}' not found in ontology '${ontologyId}'.`
    );
  }

  return { objectTypeId: otResult.rows[0].object_type_id };
}

// ---------------------------------------------------------------------------
// Route 1: POST / — Declare that an Object Type implements an Interface
//
// 10 validation rules:
//   1. Ontology exists
//   2. Object Type exists in this ontology
//   3. Interface exists (global lookup by api_name)
//   4. Object Type does not already implement this Interface
//   5. propertyMapping is non-null object with at least one key
//   6. All required Interface properties are mapped
//   7. All mapping keys are valid Interface property api_names
//   8. All mapping values are valid Object Type property api_names
//   9. Type compatibility between mapped pairs
//  10. No duplicate mapping targets
// ---------------------------------------------------------------------------

router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName } = req.params;
      const { interfaceApiName, propertyMapping } = req.body;

      // Rule 1 & 2: Ontology and Object Type exist
      const { objectTypeId } = await resolveContext(
        ontologyId,
        objectTypeApiName
      );

      // Rule 3: Interface exists (global lookup)
      if (!interfaceApiName || typeof interfaceApiName !== "string") {
        throw appError(
          "INVALID_PARAMETER",
          "interfaceApiName is required."
        );
      }

      const ifResult = await query(
        "SELECT interface_id FROM interface WHERE api_name = $1",
        [interfaceApiName]
      );
      if (ifResult.rows.length === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface '${interfaceApiName}' not found.`
        );
      }
      const interfaceId = ifResult.rows[0].interface_id;

      // Rule 4: Not already implemented
      const existingImpl = await query(
        "SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
        [objectTypeId, interfaceId]
      );
      if (existingImpl.rows.length > 0) {
        throw appError(
          "ALREADY_EXISTS",
          `Object Type '${objectTypeApiName}' already implements Interface '${interfaceApiName}'.`
        );
      }

      // Rules 5-10: Validate property mapping using the validator service
      const validation = await validatePropertyMapping(
        ontologyId,
        objectTypeApiName,
        interfaceApiName,
        propertyMapping
      );

      if (!validation.valid) {
        const err = (validation as any).error;
        throw appError(err.code, err.message);
      }

      // Insert the implementation
      const insertResult = await query(
        `INSERT INTO object_type_interface (object_type_id, interface_id, property_mapping)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [objectTypeId, interfaceId, JSON.stringify(propertyMapping)]
      );

      const row = insertResult.rows[0];

      sendCreated(res, {
        data: {
          objectTypeApiName,
          interfaceApiName,
          propertyMapping: row.property_mapping,
          createdAt: row.created_at,
        },
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
// Route 2: DELETE /:interfaceApiName — Remove Interface implementation
//
// Validation:
//   1. Ontology, Object Type, Interface exist
//   2. Object Type currently implements this Interface
// ---------------------------------------------------------------------------

router.delete(
  "/:interfaceApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName, interfaceApiName } = req.params;

      // Verify all entities exist
      const { objectTypeId } = await resolveContext(
        ontologyId,
        objectTypeApiName
      );

      const ifResult = await query(
        "SELECT interface_id FROM interface WHERE api_name = $1",
        [interfaceApiName]
      );
      if (ifResult.rows.length === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface '${interfaceApiName}' not found.`
        );
      }
      const interfaceId = ifResult.rows[0].interface_id;

      // Verify implementation exists
      const implResult = await query(
        "SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
        [objectTypeId, interfaceId]
      );
      if (implResult.rows.length === 0) {
        throw appError(
          "NOT_IMPLEMENTED",
          `Object Type '${objectTypeApiName}' does not implement Interface '${interfaceApiName}'.`
        );
      }

      // Delete the implementation
      await query(
        "DELETE FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
        [objectTypeId, interfaceId]
      );

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
// Route 3: GET / — List all Interfaces this Object Type implements
//
// Returns all Interfaces with property mappings.
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName } = req.params;

      // Verify ontology and OT exist
      const { objectTypeId } = await resolveContext(
        ontologyId,
        objectTypeApiName
      );

      // Fetch all implementations with interface details
      const result = await query(
        `SELECT
           i.api_name AS interface_api_name,
           i.display_name AS interface_display_name,
           oti.property_mapping,
           oti.created_at
         FROM object_type_interface oti
         JOIN interface i ON i.interface_id = oti.interface_id
         WHERE oti.object_type_id = $1
         ORDER BY i.api_name`,
        [objectTypeId]
      );

      const data = result.rows.map((r: any) => ({
        interfaceApiName: r.interface_api_name,
        interfaceDisplayName: r.interface_display_name,
        propertyMapping: r.property_mapping,
        createdAt: r.created_at,
      }));

      sendSuccess(res, { data });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

export default router;
