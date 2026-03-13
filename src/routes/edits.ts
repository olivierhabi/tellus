// ---------------------------------------------------------------------------
// Edit Verification Routes
//
// REST API endpoints for viewing and verifying edits (from ontology_edit
// table) that have been applied to objects via Actions.
//
// Mounted at:
//   /api/v2/ontology/:ontologyId/objectTypes/:apiName/edits
//
// Endpoints:
//   GET /                    — List all edits with filtering and pagination
//   GET /diff/:primaryKey    — Diff view: datasource vs ontology for one object
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

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

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
  primary_key_property_id: string | null;
}

async function resolveObjectType(
  ontologyId: string,
  apiName: string
): Promise<ObjectTypeInfo | null> {
  const result = await query(
    `SELECT object_type_id, api_name, primary_key_property_id
     FROM object_type
     WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, apiName]
  );
  return result.rows.length > 0 ? (result.rows[0] as ObjectTypeInfo) : null;
}

// ---------------------------------------------------------------------------
// GET / — List edits with filtering and pagination
//
// Query parameters:
//   indexed      — Filter by indexed status (boolean: true/false)
//   operation    — Filter by operation type (create/update/delete)
//   primaryKey   — Filter by exact primary key match
//   pageSize     — Number of results per page (default 50, max 500)
//   pageToken    — Base64-encoded pagination token
//
// Response includes summary stats:
//   total, pending, indexed, byOperation counts
// ---------------------------------------------------------------------------

router.get(
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
      // Parse query parameters
      // -----------------------------------------------------------------
      const indexedParam = req.query.indexed as string | undefined;
      const operationParam = req.query.operation as string | undefined;
      const primaryKeyParam = req.query.primaryKey as string | undefined;

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

      // -----------------------------------------------------------------
      // Validate filter values
      // -----------------------------------------------------------------
      if (
        indexedParam !== undefined &&
        indexedParam !== "true" &&
        indexedParam !== "false"
      ) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "indexed must be 'true' or 'false'."
        );
      }

      if (
        operationParam !== undefined &&
        !["create", "update", "delete"].includes(operationParam)
      ) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "operation must be one of: create, update, delete."
        );
      }

      // -----------------------------------------------------------------
      // Build summary stats query (unfiltered by pagination)
      // -----------------------------------------------------------------
      const statsResult = await query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE indexed = false)::int AS pending,
           COUNT(*) FILTER (WHERE indexed = true)::int AS indexed,
           COUNT(*) FILTER (WHERE operation = 'create')::int AS creates,
           COUNT(*) FILTER (WHERE operation = 'update')::int AS updates,
           COUNT(*) FILTER (WHERE operation = 'delete')::int AS deletes
         FROM ontology_edit
         WHERE object_type_api_name = $1`,
        [apiName]
      );

      const stats = statsResult.rows[0];
      const summary = {
        total: stats.total,
        pending: stats.pending,
        indexed: stats.indexed,
        byOperation: {
          create: stats.creates,
          update: stats.updates,
          delete: stats.deletes,
        },
      };

      // -----------------------------------------------------------------
      // Build filtered data query with pagination
      // -----------------------------------------------------------------
      const conditions: string[] = ["object_type_api_name = $1"];
      const values: unknown[] = [apiName];
      let paramIndex = 2;

      if (indexedParam !== undefined) {
        conditions.push(`indexed = $${paramIndex}`);
        values.push(indexedParam === "true");
        paramIndex++;
      }

      if (operationParam !== undefined) {
        conditions.push(`operation = $${paramIndex}`);
        values.push(operationParam);
        paramIndex++;
      }

      if (primaryKeyParam !== undefined) {
        conditions.push(`primary_key = $${paramIndex}`);
        values.push(primaryKeyParam);
        paramIndex++;
      }

      const whereClause = conditions.join(" AND ");

      // Count total matching records (for pagination metadata)
      const countResult = await query(
        `SELECT COUNT(*)::int AS total FROM ontology_edit WHERE ${whereClause}`,
        values
      );
      const totalFiltered = countResult.rows[0].total;

      // Fetch the page
      const dataResult = await query(
        `SELECT edit_id, object_type_api_name, primary_key, operation,
                property_values, link_edits, action_type_api_name,
                execution_id, executed_by, executed_at, indexed, indexed_at,
                branch_id
         FROM ontology_edit
         WHERE ${whereClause}
         ORDER BY executed_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...values, pageSize, offset]
      );

      // -----------------------------------------------------------------
      // Format response
      // -----------------------------------------------------------------
      const edits = dataResult.rows.map((row: any) => ({
        editId: row.edit_id,
        objectTypeApiName: row.object_type_api_name,
        primaryKey: row.primary_key,
        operation: row.operation,
        propertyValues: row.property_values,
        linkEdits: row.link_edits,
        actionTypeApiName: row.action_type_api_name,
        executionId: row.execution_id,
        executedBy: row.executed_by,
        executedAt: row.executed_at,
        indexed: row.indexed,
        indexedAt: row.indexed_at,
        branchId: row.branch_id,
      }));

      const nextOffset = offset + pageSize;
      const nextPageToken =
        nextOffset < totalFiltered ? encodePageToken(nextOffset) : null;

      return sendSuccess(res, {
        data: edits,
        summary,
        pagination: {
          pageSize,
          totalResults: totalFiltered,
          nextPageToken,
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to list edits: ${message}`
      );
    }
  }
);

// ---------------------------------------------------------------------------
// GET /diff/:primaryKey — Diff view for a specific object
//
// Shows the datasource value vs the ontology value (with edits overlaid)
// for each property of the specified object. Also lists all applied edits
// with their property changes.
//
// Source is always "user_edit".
// ---------------------------------------------------------------------------

router.get(
  "/diff/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    const { ontologyId, apiName, primaryKey } = req.params;

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
      // Fetch properties for this object type
      // -----------------------------------------------------------------
      const propsResult = await query(
        `SELECT api_name, display_name, base_type
         FROM property
         WHERE object_type_id = $1
         ORDER BY ordinal, api_name`,
        [objectType.object_type_id]
      );
      const properties = propsResult.rows;

      // -----------------------------------------------------------------
      // Fetch the backing datasource and try to read the raw value
      // from the CSV for this primary key
      // -----------------------------------------------------------------
      const dsResult = await query(
        `SELECT file_path, column_mapping, primary_key_column
         FROM backing_datasource
         WHERE object_type_id = $1`,
        [objectType.object_type_id]
      );

      let datasourceValues: Record<string, unknown> | null = null;

      if (dsResult.rows.length > 0) {
        const ds = dsResult.rows[0];
        const columnMapping =
          typeof ds.column_mapping === "string"
            ? JSON.parse(ds.column_mapping)
            : ds.column_mapping;

        // Try to read the raw CSV row for this primary key
        try {
          const { readCSV } = await import(
            "../services/indexing/csvReader"
          );
          const csvResult = await readCSV(ds.file_path);
          if (csvResult.success) {
            const row = csvResult.rows.find(
              (r: Record<string, string>) =>
                r[ds.primary_key_column] === primaryKey
            );
            if (row) {
              datasourceValues = {};
              // Map CSV columns to property api_names using columnMapping
              for (const prop of properties) {
                const csvColumn = columnMapping[prop.api_name];
                if (csvColumn && row[csvColumn] !== undefined) {
                  datasourceValues[prop.api_name] = row[csvColumn];
                } else {
                  datasourceValues[prop.api_name] = null;
                }
              }
            }
          }
        } catch {
          // CSV read failure is non-fatal for diff — we just show null for
          // datasource values
        }
      }

      // -----------------------------------------------------------------
      // Fetch all edits for this object, ordered chronologically
      // -----------------------------------------------------------------
      const editsResult = await query(
        `SELECT edit_id, operation, property_values, action_type_api_name,
                execution_id, executed_by, executed_at, indexed, indexed_at
         FROM ontology_edit
         WHERE object_type_api_name = $1 AND primary_key = $2
         ORDER BY executed_at ASC`,
        [apiName, primaryKey]
      );

      const edits = editsResult.rows;

      // -----------------------------------------------------------------
      // Compute the cumulative ontology value by replaying edits
      // on top of the datasource values
      // -----------------------------------------------------------------
      let ontologyValues: Record<string, unknown> | null = null;
      let isDeleted = false;

      if (datasourceValues || edits.length > 0) {
        // Start with datasource values as the base
        ontologyValues = datasourceValues
          ? { ...datasourceValues }
          : {};

        for (const edit of edits) {
          if (edit.operation === "delete") {
            ontologyValues = {};
            isDeleted = true;
            continue;
          }
          if (edit.operation === "create") {
            ontologyValues = {};
            isDeleted = false;
            if (edit.property_values) {
              for (const [key, value] of Object.entries(
                edit.property_values
              )) {
                ontologyValues[key] = value;
              }
            }
            continue;
          }
          if (edit.operation === "update") {
            isDeleted = false;
            if (edit.property_values) {
              for (const [key, value] of Object.entries(
                edit.property_values
              )) {
                ontologyValues![key] = value;
              }
            }
          }
        }
      }

      // -----------------------------------------------------------------
      // Build per-property diff
      // -----------------------------------------------------------------
      const propertyDiffs = properties.map((prop: any) => {
        const dsVal = datasourceValues
          ? datasourceValues[prop.api_name] ?? null
          : null;
        const ontVal =
          ontologyValues && !isDeleted
            ? ontologyValues[prop.api_name] ?? null
            : null;

        return {
          apiName: prop.api_name,
          displayName: prop.display_name,
          baseType: prop.base_type,
          datasourceValue: dsVal,
          ontologyValue: ontVal,
          modified: dsVal !== ontVal,
          source: dsVal !== ontVal ? "user_edit" : "datasource",
        };
      });

      // -----------------------------------------------------------------
      // Format edit history for response
      // -----------------------------------------------------------------
      const appliedEdits = edits.map((edit: any) => ({
        editId: edit.edit_id,
        operation: edit.operation,
        propertyChanges: edit.property_values
          ? Object.entries(edit.property_values).map(([key, value]) => ({
              property: key,
              newValue: value,
            }))
          : [],
        actionTypeApiName: edit.action_type_api_name,
        executionId: edit.execution_id,
        executedBy: edit.executed_by,
        executedAt: edit.executed_at,
        indexed: edit.indexed,
        indexedAt: edit.indexed_at,
        source: "user_edit",
      }));

      // -----------------------------------------------------------------
      // Return response
      // -----------------------------------------------------------------
      return sendSuccess(res, {
        objectTypeApiName: apiName,
        primaryKey,
        isDeleted,
        hasDatasource: dsResult.rows.length > 0,
        datasourceValues,
        currentOntologyValues: isDeleted ? null : ontologyValues,
        propertyDiffs,
        appliedEdits,
        totalEdits: edits.length,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return sendError(
        res,
        "INTERNAL_ERROR",
        `Failed to generate diff: ${message}`
      );
    }
  }
);

export default router;
