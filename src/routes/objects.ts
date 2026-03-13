// ---------------------------------------------------------------------------
// Object Query Routes — Express Router
//
// Implements the Object Set Service query API:
//   GET    /api/v2/objects/:objectType               — List objects
//   GET    /api/v2/objects/:objectType/:primaryKey    — Get single object
//   POST   /api/v2/objects/:objectType/search         — Search with filters
//   POST   /api/v2/objects/:objectType/searchFullText — Full-text search
//   POST   /api/v2/objects/:objectType/aggregate      — Aggregations
//
// Tasks 9-15, 16-20 combined.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  executeSearch,
  executeGetObject,
  executeAggregate,
  executeFullTextSearch,
} from "../services/queryExecutor";
import {
  validateSearchQuery,
  validateListQuery,
  validateAggregateQuery,
} from "../services/queryValidator";
import { resolveLinks, countLinks, searchAround, validateForeignKeys } from "../services/linkResolverService";
import linkTypeModel from "../models/linkType";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { appError } from "../utils/appError";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "QUERY_VALIDATION_ERROR",
  "OBJECT_TYPE_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "INCOMPATIBLE_FILTER",
  "INVALID_PAGE_TOKEN",
  "OPENSEARCH_ERROR",
  "OBJECT_NOT_FOUND",
]);

async function ensureObjectTypeExists(objectType: string): Promise<void> {
  const result = await query(
    "SELECT 1 FROM object_type WHERE api_name = $1",
    [objectType]
  );
  if (result.rows.length === 0) {
    const all = await query("SELECT api_name FROM object_type ORDER BY api_name");
    const available = all.rows.map((r: any) => r.api_name);
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectType}' not found. Available object types: ${available.join(", ") || "(none)"}`
    );
  }
}

function handleError(err: any, res: Response, next: NextFunction) {
  if (err.code && KNOWN_CODES.has(err.code)) {
    const status =
      err.code === "OBJECT_TYPE_NOT_FOUND" || err.code === "OBJECT_NOT_FOUND"
        ? 404
        : err.code === "OPENSEARCH_ERROR"
        ? 503
        : 400;
    return res.status(status).json({
      error: { code: err.code, message: err.message },
    });
  }
  next(err);
}

// ---------------------------------------------------------------------------
// POST /api/v2/objects/:objectType/search (MUST come before /:primaryKey)
// ---------------------------------------------------------------------------

router.post(
  "/api/v2/objects/:objectType/search",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const validated = await validateSearchQuery(req.body || {}, objectType);
      const result = await executeSearch(objectType, {
        where: validated.where,
        $orderBy: validated.$orderBy,
        $pageSize: validated.$pageSize,
        $pageToken: validated.$pageToken,
        $select: validated.$select,
      });

      const elapsed = Date.now() - start;
      console.log(
        `[SEARCH] POST /api/v2/objects/${objectType}/search → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v2/objects/:objectType/searchFullText
// ---------------------------------------------------------------------------

router.post(
  "/api/v2/objects/:objectType/searchFullText",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const { query: searchQuery, where, $orderBy, $pageSize, $pageToken, $select } =
        req.body || {};

      if (!searchQuery || typeof searchQuery !== "string" || searchQuery.trim().length === 0) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "Search query must be a non-empty string."
        );
      }

      if (searchQuery.length > 1000) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "Search query exceeds maximum length of 1000 characters."
        );
      }

      const result = await executeFullTextSearch(objectType, searchQuery.trim(), {
        where,
        $orderBy,
        $pageSize: $pageSize ?? 100,
        $pageToken,
        $select,
      });

      const elapsed = Date.now() - start;
      console.log(
        `[FULLTEXT] POST /api/v2/objects/${objectType}/searchFullText → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v2/objects/:objectType/aggregate
// ---------------------------------------------------------------------------

router.post(
  "/api/v2/objects/:objectType/aggregate",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const validated = await validateAggregateQuery(req.body || {}, objectType);
      const result = await executeAggregate(objectType, {
        where: validated.where,
        aggregations: validated.aggregations,
      });

      const elapsed = Date.now() - start;
      console.log(
        `[AGGREGATE] POST /api/v2/objects/${objectType}/aggregate → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v2/objects/:objectType (List Objects)
// ---------------------------------------------------------------------------

router.get(
  "/api/v2/objects/:objectType",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const validated = await validateListQuery(
        req.query as Record<string, any>,
        objectType
      );

      const result = await executeSearch(objectType, {
        $orderBy: validated.orderBy.length > 0 ? validated.orderBy : undefined,
        $pageSize: validated.pageSize,
        $pageToken: validated.pageToken,
        $select: validated.select,
      });

      const elapsed = Date.now() - start;
      console.log(
        `[LIST] GET /api/v2/objects/${objectType} → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v2/objects/:objectType/searchAround (Task 13-14)
// ---------------------------------------------------------------------------

router.post(
  "/api/v2/objects/:objectType/searchAround",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const { linkType: linkTypeApiName, direction, sourceFilter, targetFilter, pageSize, pageToken, $direction } = req.body;

      if (!linkTypeApiName) {
        throw appError("QUERY_VALIDATION_ERROR", "linkType is required in request body.");
      }
      if (!direction && !$direction) {
        throw appError("QUERY_VALIDATION_ERROR", "direction is required.");
      }

      // Find the link type — need ontology for this object type
      const otResult = await query(
        "SELECT ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      if (otResult.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${objectType}' not found.`);
      }
      const ontologyId = otResult.rows[0].ontology_id;

      const linkType = await linkTypeModel.getByApiName(ontologyId, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      const effectiveDirection = (direction || $direction) as "forward" | "reverse";
      const result = await searchAround(linkType, effectiveDirection, {
        sourceFilter, targetFilter, pageSize, pageToken,
      });

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v2/objects/:objectType/validateForeignKeys (Task 20)
// ---------------------------------------------------------------------------

router.post(
  "/api/v2/objects/:objectType/validateForeignKeys",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      const { object_type_id, ontology_id } = otResult.rows[0];

      const result = await validateForeignKeys(object_type_id, req.body, ontology_id);
      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v2/objects/:objectType/:primaryKey/links/:linkType (Task 12)
// ---------------------------------------------------------------------------

router.get(
  "/api/v2/objects/:objectType/:primaryKey/links/:linkType",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType, primaryKey, linkType: linkTypeApiName } = req.params;
      const { direction, pageSize, pageToken, select } = req.query;

      await ensureObjectTypeExists(objectType);

      // Resolve ontology
      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      if (otResult.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${objectType}' not found.`);
      }
      const { object_type_id, ontology_id } = otResult.rows[0];

      const linkType = await linkTypeModel.getByApiName(ontology_id, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      // Determine direction: if not explicit, infer from object type position
      let effectiveDirection: "forward" | "reverse" = "forward";
      if (direction) {
        effectiveDirection = direction as "forward" | "reverse";
      } else if (linkType.target_object_type === object_type_id && linkType.source_object_type !== object_type_id) {
        effectiveDirection = "reverse";
      }

      const result = await resolveLinks(linkType, primaryKey, effectiveDirection, {
        pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
        pageToken: pageToken as string,
        select: select ? (select as string).split(",") : undefined,
      });

      // Format based on cardinality
      const isSingle = (
        (linkType.cardinality === "ONE_TO_ONE") ||
        (linkType.cardinality === "MANY_TO_ONE" && effectiveDirection === "forward")
      );

      if (isSingle) {
        return sendSuccess(res, {
          linkedObject: result.linkedObjects.length > 0 ? result.linkedObjects[0] : null,
        });
      }

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v2/objects/:objectType/:primaryKey/links/:linkType/count (Task 15)
// ---------------------------------------------------------------------------

router.get(
  "/api/v2/objects/:objectType/:primaryKey/links/:linkType/count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType, primaryKey, linkType: linkTypeApiName } = req.params;
      const { direction } = req.query;

      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      const { object_type_id, ontology_id } = otResult.rows[0];

      const linkType = await linkTypeModel.getByApiName(ontology_id, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      let effectiveDirection: "forward" | "reverse" = "forward";
      if (direction) {
        effectiveDirection = direction as "forward" | "reverse";
      } else if (linkType.target_object_type === object_type_id && linkType.source_object_type !== object_type_id) {
        effectiveDirection = "reverse";
      }

      const count = await countLinks(linkType, primaryKey, effectiveDirection);
      return sendSuccess(res, { linkTypeApiName, direction: effectiveDirection, count });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v2/objects/:objectType/:primaryKey/editHistory (Task 17)
//
// Returns the complete edit history for a single object in reverse
// chronological order (most recent first). Each entry shows what operation
// was performed, what properties were changed, who made the change, and
// when. Essential for audit and compliance — a tax auditor must be able to
// see every change ever made to a taxpayer record.
//
// Query parameters:
//   $pageSize  — integer, default 50, max 500
//   $pageToken — base64-encoded cursor (executed_at of last item on prev page)
//   startTime  — ISO timestamp, only edits on or after this time
//   endTime    — ISO timestamp, only edits on or before this time
// ---------------------------------------------------------------------------

router.get(
  "/api/v2/objects/:objectType/:primaryKey/editHistory",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      // ------------------------------------------------------------------
      // Parse and validate query parameters
      // ------------------------------------------------------------------

      const rawPageSize = req.query.$pageSize ?? req.query.pageSize;
      let pageSize = 50;
      if (rawPageSize !== undefined) {
        pageSize = parseInt(String(rawPageSize), 10);
        if (isNaN(pageSize) || pageSize < 1) {
          throw appError(
            "QUERY_VALIDATION_ERROR",
            "$pageSize must be a positive integer."
          );
        }
        if (pageSize > 500) {
          throw appError(
            "QUERY_VALIDATION_ERROR",
            "$pageSize must not exceed 500."
          );
        }
      }

      const rawPageToken = req.query.$pageToken ?? req.query.pageToken;
      let cursorTimestamp: string | null = null;
      if (rawPageToken !== undefined && rawPageToken !== "") {
        try {
          cursorTimestamp = Buffer.from(String(rawPageToken), "base64").toString();
          // Basic ISO timestamp validation
          const parsed = new Date(cursorTimestamp);
          if (isNaN(parsed.getTime())) {
            throw new Error("Invalid date");
          }
        } catch {
          throw appError(
            "INVALID_PAGE_TOKEN",
            "Invalid $pageToken. Must be a valid base64-encoded ISO timestamp."
          );
        }
      }

      const startTime =
        req.query.startTime !== undefined && req.query.startTime !== ""
          ? String(req.query.startTime)
          : null;
      const endTime =
        req.query.endTime !== undefined && req.query.endTime !== ""
          ? String(req.query.endTime)
          : null;

      // Validate startTime/endTime are valid ISO timestamps if provided
      if (startTime !== null && isNaN(new Date(startTime).getTime())) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "startTime must be a valid ISO 8601 timestamp."
        );
      }
      if (endTime !== null && isNaN(new Date(endTime).getTime())) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "endTime must be a valid ISO 8601 timestamp."
        );
      }

      // ------------------------------------------------------------------
      // Query: Total count (with same WHERE filters, no LIMIT)
      // ------------------------------------------------------------------

      const countResult = await query(
        `SELECT COUNT(*)::int AS total
         FROM ontology_edit
         WHERE object_type_api_name = $1
           AND primary_key = $2
           AND ($3::timestamptz IS NULL OR executed_at >= $3)
           AND ($4::timestamptz IS NULL OR executed_at <= $4)`,
        [objectType, primaryKey, startTime, endTime]
      );
      const totalCount: number = countResult.rows[0].total;

      // ------------------------------------------------------------------
      // Query: Edit history page with LEFT JOIN to audit log
      //
      // The LEFT JOIN on execution_id fetches the action display name and
      // execution result from the audit log, so the response includes
      // richer context about the action that produced each edit.
      // ------------------------------------------------------------------

      const editsResult = await query(
        `SELECT
           e.edit_id,
           e.object_type_api_name,
           e.primary_key,
           e.operation,
           e.property_values,
           e.link_edits,
           e.action_type_api_name,
           e.execution_id,
           e.action_parameters,
           e.executed_by,
           e.executed_at,
           e.indexed,
           e.indexed_at,
           a.action_type_display_name,
           a.result AS execution_result
         FROM ontology_edit e
         LEFT JOIN action_audit_log a ON e.execution_id = a.execution_id
         WHERE e.object_type_api_name = $1
           AND e.primary_key = $2
           AND ($3::timestamptz IS NULL OR e.executed_at >= $3)
           AND ($4::timestamptz IS NULL OR e.executed_at <= $4)
           AND ($5::timestamptz IS NULL OR e.executed_at < $5)
         ORDER BY e.executed_at DESC
         LIMIT $6`,
        [objectType, primaryKey, startTime, endTime, cursorTimestamp, pageSize]
      );

      const rows = editsResult.rows;

      // ------------------------------------------------------------------
      // Format response
      //
      // TODO: For update operations, compute a full "before vs. after" diff
      // by comparing property_values with the object state before the edit.
      // For week 1 we just show what was SET (property_values from the edit).
      // ------------------------------------------------------------------

      const data = rows.map((row: Record<string, unknown>) => ({
        editId: row.edit_id,
        operation: row.operation,
        propertyValues: row.property_values ?? {},
        linkEdits: row.link_edits ?? [],
        actionTypeApiName: row.action_type_api_name ?? null,
        actionTypeDisplayName: row.action_type_display_name ?? null,
        executionId: row.execution_id ?? null,
        executionResult: row.execution_result ?? null,
        actionParameters: row.action_parameters ?? {},
        executedBy: row.executed_by,
        executedAt: row.executed_at,
        indexed: row.indexed,
        indexedAt: row.indexed_at ?? null,
      }));

      // ------------------------------------------------------------------
      // Build next page token
      //
      // If we got a full page of results, there might be more. Encode the
      // executed_at of the last item as the cursor for the next page.
      // ------------------------------------------------------------------

      let nextPageToken: string | null = null;
      if (rows.length === pageSize) {
        const lastExecutedAt = String(rows[rows.length - 1].executed_at);
        nextPageToken = Buffer.from(lastExecutedAt).toString("base64");
      }

      const elapsed = Date.now() - start;
      console.log(
        `[EDIT_HISTORY] GET /api/v2/objects/${objectType}/${primaryKey}/editHistory → 200 (${data.length}/${totalCount} edits, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        objectType,
        primaryKey,
        data,
        nextPageToken,
        totalCount,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v2/objects/:objectType/:primaryKey (Single Object)
// ---------------------------------------------------------------------------

router.get(
  "/api/v2/objects/:objectType/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      const obj = await executeGetObject(objectType, primaryKey);
      if (!obj) {
        throw appError(
          "OBJECT_NOT_FOUND",
          `Object with primary key '${primaryKey}' not found in object type '${objectType}'.`
        );
      }

      const elapsed = Date.now() - start;
      console.log(
        `[GET] GET /api/v2/objects/${objectType}/${primaryKey} → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, obj);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

export default router;
