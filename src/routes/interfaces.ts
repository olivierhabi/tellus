// ---------------------------------------------------------------------------
// Interface Routes — Express Router
//
// CRUD for Interfaces (shared property contracts for Object Types).
//
// Mounted at: /api/v1/ontology/:ontologyId/interfaces
//
// Interfaces define a set of typed properties that Object Types can
// implement. This enables polymorphic queries across heterogeneous
// Object Types that share a common property structure.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query, getClient } from "../db";
import { appError } from "../utils/appError";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  executePolymorphicSearch,
  executePolymorphicAggregation,
} from "../services/interfaceQueryService";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "ONTOLOGY_NOT_FOUND",
  "INTERFACE_NOT_FOUND",
  "INTERFACE_ALREADY_EXISTS",
  "INTERFACE_IN_USE",
  "INVALID_API_NAME",
  "VALIDATION_FAILED",
  "PROPERTY_IN_USE",
  "BASE_TYPE_MISMATCH",
  "OPENSEARCH_ERROR",
  "QUERY_VALIDATION_ERROR",
  "INVALID_PAGE_TOKEN",
  "INVALID_PARAMETER",
  "INTERFACE_CYCLE_DETECTED",
  "INCOMPATIBLE_PROPERTY_TYPE",
  "INVALID_AGGREGATION",
]);

// ---------------------------------------------------------------------------
// Valid base types for interface properties
// ---------------------------------------------------------------------------

const VALID_BASE_TYPES = new Set([
  "string",
  "boolean",
  "integer",
  "long",
  "double",
  "float",
  "date",
  "timestamp",
  "byte",
  "short",
  "decimal",
  "geopoint",
  "geoshape",
  "string_array",
  "integer_array",
  "long_array",
  "double_array",
  "boolean_array",
  "timestamp_array",
  "struct",
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;

// ---------------------------------------------------------------------------
// Helper: verify ontology exists
// ---------------------------------------------------------------------------

async function verifyOntology(ontologyId: string): Promise<void> {
  const result = await query(
    "SELECT 1 FROM ontology WHERE ontology_id = $1",
    [ontologyId]
  );
  if (result.rowCount === 0) {
    throw appError("ONTOLOGY_NOT_FOUND", `Ontology ${ontologyId} not found.`);
  }
}

// ---------------------------------------------------------------------------
// Helper: group flat JOIN rows into nested Interface JSON
// ---------------------------------------------------------------------------

interface FlatRow {
  interface_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  // interface_property columns
  interface_property_id: string | null;
  ip_api_name: string | null;
  ip_display_name: string | null;
  base_type: string | null;
  is_required: boolean | null;
  ordinal: number | null;
  // implementing object type columns
  implementing_object_type: string | null;
  property_mapping: Record<string, string> | null;
}

function groupInterfaceRows(rows: FlatRow[]): Record<string, unknown>[] {
  const interfaceMap = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    let iface = interfaceMap.get(row.interface_id);
    if (!iface) {
      iface = {
        interfaceId: row.interface_id,
        ontologyId: row.ontology_id,
        apiName: row.api_name,
        displayName: row.display_name,
        description: row.description,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        properties: [] as Record<string, unknown>[],
        implementingObjectTypes: [] as Record<string, unknown>[],
        _seenProps: new Set<string>(),
        _seenOts: new Set<string>(),
      };
      interfaceMap.set(row.interface_id, iface);
    }

    // Add property if present and not already added (deduplicate by property id)
    if (row.interface_property_id && row.ip_api_name) {
      const seenProps = iface._seenProps as Set<string>;
      if (!seenProps.has(row.interface_property_id)) {
        seenProps.add(row.interface_property_id);
        (iface.properties as Record<string, unknown>[]).push({
          interfacePropertyId: row.interface_property_id,
          apiName: row.ip_api_name,
          displayName: row.ip_display_name,
          baseType: row.base_type,
          isRequired: row.is_required,
          ordinal: row.ordinal,
        });
      }
    }

    // Add implementing object type if present and not already added
    if (row.implementing_object_type) {
      const seen = iface._seenOts as Set<string>;
      if (!seen.has(row.implementing_object_type)) {
        seen.add(row.implementing_object_type);
        (iface.implementingObjectTypes as Record<string, unknown>[]).push({
          objectTypeApiName: row.implementing_object_type,
          propertyMapping: row.property_mapping,
        });
      }
    }
  }

  // Sort properties by ordinal and remove internal tracking sets before returning
  const results: Record<string, unknown>[] = [];
  for (const iface of interfaceMap.values()) {
    (iface.properties as Record<string, unknown>[]).sort(
      (a, b) => ((a.ordinal as number) ?? 0) - ((b.ordinal as number) ?? 0)
    );
    delete iface._seenProps;
    delete iface._seenOts;
    results.push(iface);
  }
  return results;
}

// ---------------------------------------------------------------------------
// The three-way JOIN query used by both list and get-single endpoints
// ---------------------------------------------------------------------------

const THREE_WAY_JOIN_SQL = `
  SELECT
    i.interface_id,
    i.ontology_id,
    i.api_name,
    i.display_name,
    i.description,
    i.created_at,
    i.updated_at,
    ip.interface_property_id,
    ip.api_name AS ip_api_name,
    ip.display_name AS ip_display_name,
    ip.base_type,
    ip.is_required,
    ip.ordinal,
    ot.api_name AS implementing_object_type,
    oti.property_mapping
  FROM interface i
  LEFT JOIN interface_property ip ON ip.interface_id = i.interface_id
  LEFT JOIN object_type_interface oti ON oti.interface_id = i.interface_id
  LEFT JOIN object_type ot ON ot.object_type_id = oti.object_type_id
`;

// ---------------------------------------------------------------------------
// Route 1: POST / — Create a new Interface
// ---------------------------------------------------------------------------

router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;
      const { apiName, displayName, description, properties } = req.body;

      // ---------------------------------------------------------------
      // Validation (13 rules)
      // ---------------------------------------------------------------

      // Rule 1: ontology must exist
      await verifyOntology(ontologyId);

      // Rule 2: apiName required
      if (!apiName || typeof apiName !== "string") {
        throw appError(
          "VALIDATION_FAILED",
          "apiName is required and must be a string."
        );
      }

      // Rule 3: apiName must be PascalCase
      if (!PASCAL_CASE_RE.test(apiName)) {
        throw appError(
          "INVALID_API_NAME",
          `apiName "${apiName}" must be PascalCase (start with uppercase, alphanumeric only).`
        );
      }

      // Rule 4: displayName required, max 500 chars
      if (!displayName || typeof displayName !== "string") {
        throw appError(
          "VALIDATION_FAILED",
          "displayName is required and must be a string."
        );
      }
      if (displayName.length > 500) {
        throw appError(
          "VALIDATION_FAILED",
          "displayName must be at most 500 characters."
        );
      }

      // Rule 5: description optional, max 10000 chars
      if (description !== undefined && description !== null) {
        if (typeof description !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            "description must be a string if provided."
          );
        }
        if (description.length > 10000) {
          throw appError(
            "VALIDATION_FAILED",
            "description must be at most 10000 characters."
          );
        }
      }

      // Rule 6: properties required, non-empty array, max 100
      if (!Array.isArray(properties) || properties.length === 0) {
        throw appError(
          "VALIDATION_FAILED",
          "properties must be a non-empty array."
        );
      }
      if (properties.length > 100) {
        throw appError(
          "VALIDATION_FAILED",
          "properties must contain at most 100 entries."
        );
      }

      // Rule 7: Validate each property
      const seenPropNames = new Set<string>();
      for (let i = 0; i < properties.length; i++) {
        const prop = properties[i];
        const prefix = `properties[${i}]`;

        // Rule 7a: apiName required and camelCase
        if (!prop.apiName || typeof prop.apiName !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            `${prefix}.apiName is required and must be a string.`
          );
        }
        if (!CAMEL_CASE_RE.test(prop.apiName)) {
          throw appError(
            "INVALID_API_NAME",
            `${prefix}.apiName "${prop.apiName}" must be camelCase (start with lowercase, alphanumeric only).`
          );
        }

        // Rule 7b: displayName required
        if (!prop.displayName || typeof prop.displayName !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            `${prefix}.displayName is required and must be a string.`
          );
        }

        // Rule 7c: baseType required and from valid set
        if (!prop.baseType || typeof prop.baseType !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            `${prefix}.baseType is required and must be a string.`
          );
        }
        if (!VALID_BASE_TYPES.has(prop.baseType)) {
          throw appError(
            "VALIDATION_FAILED",
            `${prefix}.baseType "${prop.baseType}" is not a valid base type.`
          );
        }

        // Rule 7d: isRequired must be boolean if provided (default false)
        if (
          prop.isRequired !== undefined &&
          prop.isRequired !== null &&
          typeof prop.isRequired !== "boolean"
        ) {
          throw appError(
            "VALIDATION_FAILED",
            `${prefix}.isRequired must be a boolean if provided.`
          );
        }

        // Rule 8: Unique property apiNames within the Interface
        if (seenPropNames.has(prop.apiName)) {
          throw appError(
            "VALIDATION_FAILED",
            `Duplicate property apiName "${prop.apiName}" within the Interface.`
          );
        }
        seenPropNames.add(prop.apiName);
      }

      // Rule 9: apiName must be globally unique (no conflict with other interfaces)
      const existingInterface = await query(
        "SELECT 1 FROM interface WHERE api_name = $1",
        [apiName]
      );
      if (existingInterface.rowCount! > 0) {
        throw appError(
          "INTERFACE_ALREADY_EXISTS",
          `Interface with apiName "${apiName}" already exists.`
        );
      }

      // Rule 10: apiName must not conflict with object type names in this ontology
      const existingObjectType = await query(
        "SELECT 1 FROM object_type WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, apiName]
      );
      if (existingObjectType.rowCount! > 0) {
        throw appError(
          "VALIDATION_FAILED",
          `apiName "${apiName}" conflicts with an existing Object Type in this ontology.`
        );
      }

      // ---------------------------------------------------------------
      // Insert within a transaction
      // ---------------------------------------------------------------
      const client = await getClient();
      try {
        await client.query("BEGIN");

        // Insert the interface
        const insertInterfaceResult = await client.query(
          `INSERT INTO interface (ontology_id, api_name, display_name, description)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [ontologyId, apiName, displayName, description || null]
        );
        const interfaceRow = insertInterfaceResult.rows[0];

        // Insert all properties with ordinal
        const insertedProperties: Record<string, unknown>[] = [];
        for (let i = 0; i < properties.length; i++) {
          const prop = properties[i];
          const propResult = await client.query(
            `INSERT INTO interface_property
               (interface_id, api_name, display_name, base_type, is_required, ordinal)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              interfaceRow.interface_id,
              prop.apiName,
              prop.displayName,
              prop.baseType,
              prop.isRequired ?? false,
              i,
            ]
          );
          insertedProperties.push(propResult.rows[0]);
        }

        await client.query("COMMIT");

        // Format response — properties as array sorted by ordinal
        const propertiesArray = insertedProperties.map((p: any) => ({
          interfacePropertyId: p.interface_property_id,
          apiName: p.api_name,
          displayName: p.display_name,
          baseType: p.base_type,
          isRequired: p.is_required,
          ordinal: p.ordinal,
        }));

        sendCreated(res, {
          interfaceId: interfaceRow.interface_id,
          ontologyId: interfaceRow.ontology_id,
          apiName: interfaceRow.api_name,
          displayName: interfaceRow.display_name,
          description: interfaceRow.description,
          createdAt: interfaceRow.created_at,
          updatedAt: interfaceRow.updated_at,
          properties: propertiesArray,
          implementingObjectTypes: [],
        });
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET / — List all Interfaces in an ontology (3-way JOIN)
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId } = req.params;

      await verifyOntology(ontologyId);

      const result = await query(
        `${THREE_WAY_JOIN_SQL}
         WHERE i.ontology_id = $1
         ORDER BY i.api_name, ip.ordinal, ot.api_name`,
        [ontologyId]
      );

      const interfaces = groupInterfaceRows(result.rows as FlatRow[]);

      sendSuccess(res, { data: interfaces, totalCount: interfaces.length });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: GET /:interfaceApiName — Get a single Interface (3-way JOIN)
// ---------------------------------------------------------------------------

router.get(
  "/:interfaceApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, interfaceApiName } = req.params;

      await verifyOntology(ontologyId);

      const result = await query(
        `${THREE_WAY_JOIN_SQL}
         WHERE i.ontology_id = $1 AND i.api_name = $2
         ORDER BY i.api_name, ip.ordinal, ot.api_name`,
        [ontologyId, interfaceApiName]
      );

      if (result.rowCount === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface "${interfaceApiName}" not found in ontology ${ontologyId}.`
        );
      }

      const interfaces = groupInterfaceRows(result.rows as FlatRow[]);
      sendSuccess(res, { data: interfaces[0] });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 4: PUT /:interfaceApiName — Update an Interface definition
//
// Updates displayName, description, and properties. apiName is immutable.
// Handles property additions/removals/modifications atomically.
// Validates:
//   - Cannot remove a property that is mapped by an implementing type
//   - Cannot change base_type of a property that is mapped
// ---------------------------------------------------------------------------

router.put(
  "/:interfaceApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, interfaceApiName } = req.params;
      const { displayName, description, properties, parentInterfaceApiName } =
        req.body;

      await verifyOntology(ontologyId);

      // Fetch the existing interface
      const existing = await query(
        "SELECT * FROM interface WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, interfaceApiName]
      );
      if (existing.rowCount === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface "${interfaceApiName}" not found in ontology ${ontologyId}.`
        );
      }
      const interfaceRow = existing.rows[0];
      const interfaceId = interfaceRow.interface_id;

      // Spec §Task 8 — inheritance DAG cycle detection. If the caller wants
      // to change the parent, verify no cycle would be introduced.
      if (parentInterfaceApiName !== undefined) {
        let parentId: string | null = null;
        if (parentInterfaceApiName !== null) {
          const parentRow = await query(
            "SELECT interface_id FROM interface WHERE ontology_id = $1 AND api_name = $2",
            [ontologyId, parentInterfaceApiName]
          );
          if (parentRow.rowCount === 0) {
            throw appError(
              "INTERFACE_NOT_FOUND",
              `Parent interface "${parentInterfaceApiName}" not found.`
            );
          }
          parentId = parentRow.rows[0].interface_id;
        }
        const { assertNoInheritanceCycle } = await import(
          "../services/interfaceInheritance"
        );
        await assertNoInheritanceCycle(interfaceId, parentId);
        await query(
          "UPDATE interface SET parent_interface_id = $1 WHERE interface_id = $2",
          [parentId, interfaceId]
        );
      }

      // Validate displayName if provided
      if (displayName !== undefined) {
        if (!displayName || typeof displayName !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            "displayName must be a non-empty string."
          );
        }
        if (displayName.length > 500) {
          throw appError(
            "VALIDATION_FAILED",
            "displayName must be at most 500 characters."
          );
        }
      }

      // Validate description if provided
      if (description !== undefined && description !== null) {
        if (typeof description !== "string") {
          throw appError(
            "VALIDATION_FAILED",
            "description must be a string if provided."
          );
        }
        if (description.length > 10000) {
          throw appError(
            "VALIDATION_FAILED",
            "description must be at most 10000 characters."
          );
        }
      }

      // Validate properties if provided
      if (properties !== undefined) {
        if (!Array.isArray(properties) || properties.length === 0) {
          throw appError(
            "VALIDATION_FAILED",
            "properties must be a non-empty array."
          );
        }
        if (properties.length > 100) {
          throw appError(
            "VALIDATION_FAILED",
            "properties must contain at most 100 entries."
          );
        }

        const seenPropNames = new Set<string>();
        for (let i = 0; i < properties.length; i++) {
          const prop = properties[i];
          const prefix = `properties[${i}]`;

          if (!prop.apiName || typeof prop.apiName !== "string") {
            throw appError(
              "VALIDATION_FAILED",
              `${prefix}.apiName is required and must be a string.`
            );
          }
          if (!CAMEL_CASE_RE.test(prop.apiName)) {
            throw appError(
              "INVALID_API_NAME",
              `${prefix}.apiName "${prop.apiName}" must be camelCase.`
            );
          }
          if (!prop.displayName || typeof prop.displayName !== "string") {
            throw appError(
              "VALIDATION_FAILED",
              `${prefix}.displayName is required and must be a string.`
            );
          }
          if (!prop.baseType || !VALID_BASE_TYPES.has(prop.baseType)) {
            throw appError(
              "VALIDATION_FAILED",
              `${prefix}.baseType "${prop.baseType}" is not valid.`
            );
          }
          if (
            prop.isRequired !== undefined &&
            prop.isRequired !== null &&
            typeof prop.isRequired !== "boolean"
          ) {
            throw appError(
              "VALIDATION_FAILED",
              `${prefix}.isRequired must be a boolean if provided.`
            );
          }
          if (seenPropNames.has(prop.apiName)) {
            throw appError(
              "VALIDATION_FAILED",
              `Duplicate property apiName "${prop.apiName}" within the Interface.`
            );
          }
          seenPropNames.add(prop.apiName);
        }
      }

      // ---------------------------------------------------------------
      // Perform update in a transaction
      // ---------------------------------------------------------------
      const client = await getClient();
      try {
        await client.query("BEGIN");

        // Update interface metadata
        const updateFields: string[] = [];
        const updateValues: unknown[] = [];
        let paramIndex = 1;

        if (displayName !== undefined) {
          updateFields.push(`display_name = $${paramIndex++}`);
          updateValues.push(displayName);
        }
        if (description !== undefined) {
          updateFields.push(`description = $${paramIndex++}`);
          updateValues.push(description);
        }

        if (updateFields.length > 0) {
          updateFields.push(`updated_at = now()`);
          updateValues.push(interfaceId);
          await client.query(
            `UPDATE interface SET ${updateFields.join(", ")} WHERE interface_id = $${paramIndex}`,
            updateValues
          );
        }

        // Handle property changes if properties are provided
        if (properties !== undefined) {
          // Get current properties
          const currentPropsResult = await client.query(
            "SELECT * FROM interface_property WHERE interface_id = $1",
            [interfaceId]
          );
          const currentProps = currentPropsResult.rows;
          const currentPropMap = new Map(
            currentProps.map((p: any) => [p.api_name, p])
          );

          // Get implementing types for constraint validation
          const implementorsResult = await client.query(
            "SELECT oti.*, ot.api_name AS ot_api_name FROM object_type_interface oti JOIN object_type ot ON ot.object_type_id = oti.object_type_id WHERE oti.interface_id = $1",
            [interfaceId]
          );
          const implementors = implementorsResult.rows;

          // Build set of new property apiNames
          const newPropNames = new Set(
            properties.map((p: any) => p.apiName as string)
          );

          // Check for removed properties that are in use by implementing types
          for (const currentProp of currentProps) {
            if (!newPropNames.has(currentProp.api_name)) {
              // This property is being removed — check if any implementor maps it
              for (const impl of implementors) {
                const mapping = impl.property_mapping as Record<string, string>;
                if (mapping && currentProp.api_name in mapping) {
                  throw appError(
                    "PROPERTY_IN_USE",
                    `Cannot remove property "${currentProp.api_name}" because it is mapped by Object Type "${impl.ot_api_name}".`
                  );
                }
              }
            }
          }

          // Check for base_type changes on mapped properties
          for (const prop of properties) {
            const existing = currentPropMap.get(prop.apiName);
            if (existing && (existing as any).base_type !== prop.baseType) {
              // base_type is changing — check if any implementor maps this property
              for (const impl of implementors) {
                const mapping = impl.property_mapping as Record<string, string>;
                if (mapping && prop.apiName in mapping) {
                  throw appError(
                    "BASE_TYPE_MISMATCH",
                    `Cannot change base_type of property "${prop.apiName}" from "${(existing as any).base_type}" to "${prop.baseType}" because it is mapped by Object Type "${impl.ot_api_name}".`
                  );
                }
              }
            }
          }

          // Delete all current properties and re-insert (atomic replacement)
          await client.query(
            "DELETE FROM interface_property WHERE interface_id = $1",
            [interfaceId]
          );

          for (let i = 0; i < properties.length; i++) {
            const prop = properties[i];
            await client.query(
              `INSERT INTO interface_property
                 (interface_id, api_name, display_name, base_type, is_required, ordinal)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                interfaceId,
                prop.apiName,
                prop.displayName,
                prop.baseType,
                prop.isRequired ?? false,
                i,
              ]
            );
          }

          // Update the interface's updated_at timestamp
          await client.query(
            "UPDATE interface SET updated_at = now() WHERE interface_id = $1",
            [interfaceId]
          );
        }

        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK");
        throw txErr;
      } finally {
        client.release();
      }

      // Re-fetch the full interface with 3-way JOIN for the response
      const refreshed = await query(
        `${THREE_WAY_JOIN_SQL}
         WHERE i.ontology_id = $1 AND i.api_name = $2
         ORDER BY i.api_name, ip.ordinal, ot.api_name`,
        [ontologyId, interfaceApiName]
      );

      const interfaces = groupInterfaceRows(refreshed.rows as FlatRow[]);
      sendSuccess(res, { data: interfaces[0] });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: DELETE /:interfaceApiName — Delete an Interface
//
// Safety check: rejects with 409 if any Object Types implement this Interface.
// ---------------------------------------------------------------------------

router.delete(
  "/:interfaceApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, interfaceApiName } = req.params;

      await verifyOntology(ontologyId);

      // Fetch the interface
      const existing = await query(
        "SELECT interface_id FROM interface WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, interfaceApiName]
      );
      if (existing.rowCount === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface "${interfaceApiName}" not found in ontology ${ontologyId}.`
        );
      }
      const interfaceId = existing.rows[0].interface_id;

      // Safety check: reject if any Object Types implement this Interface
      const implementors = await query(
        `SELECT ot.api_name
         FROM object_type_interface oti
         JOIN object_type ot ON ot.object_type_id = oti.object_type_id
         WHERE oti.interface_id = $1`,
        [interfaceId]
      );

      if (implementors.rowCount! > 0) {
        const names = implementors.rows
          .map((r: any) => r.api_name)
          .join(", ");
        throw appError(
          "INTERFACE_IN_USE",
          `Cannot delete Interface "${interfaceApiName}" because it is implemented by: ${names}. Remove implementations first.`
        );
      }

      // Delete the interface (CASCADE will remove interface_property rows)
      await query("DELETE FROM interface WHERE interface_id = $1", [
        interfaceId,
      ]);

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
// Route 6: POST /:interfaceApiName/search — Polymorphic search (Task 8)
//
// Translates Interface property names to OT property names using mappings,
// executes queries across all implementing OTs via OpenSearch _msearch,
// merges results with __objectType field, maps property names back to
// Interface names. Pagination via offset-based slicing with base64 pageToken.
// ---------------------------------------------------------------------------

router.post(
  "/:interfaceApiName/search",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { ontologyId, interfaceApiName } = req.params;

      await verifyOntology(ontologyId);

      // Look up Interface
      const ifResult = await query(
        "SELECT interface_id FROM interface WHERE api_name = $1 AND ontology_id = $2",
        [interfaceApiName, ontologyId]
      );
      if (ifResult.rowCount === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface "${interfaceApiName}" not found in ontology ${ontologyId}.`
        );
      }

      const interfaceId = ifResult.rows[0].interface_id;

      const {
        where,
        $pageSize = 100,
        $pageToken,
        $orderBy,
        $select,
      } = req.body || {};

      const result = await executePolymorphicSearch(interfaceId, where, {
        pageSize: Math.min(Math.max($pageSize || 100, 1), 1000),
        pageToken: $pageToken || null,
        orderBy: $orderBy || [],
        select: $select || null,
      });

      const elapsed = Date.now() - start;
      console.log(
        `[INTERFACE_SEARCH] POST .../${interfaceApiName}/search → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
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
// Route 7: POST /:interfaceApiName/aggregate — Polymorphic aggregation (Task 9)
//
// Same query translation as search. Merge aggregation results:
// count (sum), avg (weighted), sum, min, max, terms (merge buckets),
// date_histogram (merge by key). Handle empty/no-implementing-types gracefully.
// ---------------------------------------------------------------------------

router.post(
  "/:interfaceApiName/aggregate",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { ontologyId, interfaceApiName } = req.params;

      await verifyOntology(ontologyId);

      // Look up Interface
      const ifResult = await query(
        "SELECT interface_id FROM interface WHERE api_name = $1 AND ontology_id = $2",
        [interfaceApiName, ontologyId]
      );
      if (ifResult.rowCount === 0) {
        throw appError(
          "INTERFACE_NOT_FOUND",
          `Interface "${interfaceApiName}" not found in ontology ${ontologyId}.`
        );
      }

      const interfaceId = ifResult.rows[0].interface_id;

      const { where, aggregations } = req.body || {};

      if (!Array.isArray(aggregations) || aggregations.length === 0) {
        throw appError(
          "INVALID_PARAMETER",
          "aggregations must be a non-empty array."
        );
      }

      // Validate aggregation specs
      for (const spec of aggregations) {
        if (!spec.name || typeof spec.name !== "string") {
          throw appError(
            "INVALID_PARAMETER",
            "Each aggregation must have a 'name' string."
          );
        }
        if (!spec.type || typeof spec.type !== "string") {
          throw appError(
            "INVALID_PARAMETER",
            `Aggregation '${spec.name}' must have a 'type' string.`
          );
        }
      }

      const result = await executePolymorphicAggregation(
        interfaceId,
        where,
        aggregations
      );

      const elapsed = Date.now() - start;
      console.log(
        `[INTERFACE_AGGREGATE] POST .../${interfaceApiName}/aggregate → 200 (${elapsed}ms)`
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

export default router;
