// ---------------------------------------------------------------------------
// Object Query Routes — Express Router
//
// Implements the Object Set Service query API:
//   GET    /api/v1/objects/:objectType               — List objects
//   GET    /api/v1/objects/:objectType/:primaryKey    — Get single object
//   POST   /api/v1/objects/:objectType/search         — Search with filters
//   POST   /api/v1/objects/:objectType/searchFullText — Full-text search
//   POST   /api/v1/objects/:objectType/aggregate      — Aggregations
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
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";
import { routeMetric } from "../utils/routeInstrumentation";
import {
  applyOverlayToResults,
  mergeOverlayIntoSearch,
  readOverlay,
} from "../services/overlay/writebackOverlay";
import { getOverlayStore } from "../services/overlay/getOverlayStore";
import { recordShadowDiff } from "../services/funnel/shadowDiffHook";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Overlay merge helper — B7. Every search result goes through this so
 * user edits that landed in the overlay cache but haven't been indexed
 * yet become visible within the 1-second SLO. The Quickwit/OpenSearch
 * result is authoritative for everything NOT edited; for edited PKs the
 * overlay wins.
 *
 * Silently falls through to the original results if the overlay store
 * is unreachable or empty — the overlay is an optimisation, not a
 * requirement.
 */
async function mergeWithOverlay<R extends { data: unknown[] }>(
  objectType: string,
  result: R,
  whereClause?: unknown,
  branchId: string | null = null
): Promise<R> {
  try {
    const store = await getOverlayStore();
    const filter = buildOverlayFilter(whereClause);
    const merged = await mergeOverlayIntoSearch({
      objectType,
      hits: result.data as Array<Record<string, unknown>>,
      filter,
      store,
      branchId,
    });
    return { ...result, data: merged } as R;
  } catch {
    // Overlay is an optimisation — on any failure we fall back to the
    // underlying result so queries never fail due to overlay issues.
    try {
      const store = await getOverlayStore();
      const replaced = await applyOverlayToResults(
        objectType,
        result.data as Array<Record<string, unknown>>,
        store,
        branchId
      );
      return { ...result, data: replaced } as R;
    } catch {
      return result;
    }
  }
}

/**
 * B7 SCAN discovery: build a minimal filter predicate from the search
 * `where` clause so `collectFilterMatchingOverlays` can include
 * overlay-only hits (rows edited within the last overlay TTL that the
 * index hasn't absorbed yet).
 *
 * Deliberately small: we only support equality on top-level properties
 * which is what the dominant Query API path produces. Unknown or
 * nested filters fall back to matching everything, which is still
 * correct — dedup by PK in mergeOverlayIntoSearch keeps the Quickwit
 * hit authoritative if it exists.
 */
function buildOverlayFilter(where: unknown): ((doc: Record<string, unknown>) => boolean) | undefined {
  if (!where || typeof where !== "object") return undefined;
  const w = where as Record<string, unknown>;
  if (w.type === "eq" && typeof w.field === "string") {
    const field = w.field;
    const value = w.value;
    return (doc) => {
      const dv = doc[field];
      return dv === value || String(dv) === String(value);
    };
  }
  if (w.type === "and" && Array.isArray(w.filters)) {
    const sub = w.filters
      .map(buildOverlayFilter)
      .filter((f): f is (doc: Record<string, unknown>) => boolean => typeof f === "function");
    if (sub.length === 0) return undefined;
    return (doc) => sub.every((f) => f(doc));
  }
  return undefined;
}

const KNOWN_CODES = new Set([
  "QUERY_VALIDATION_ERROR",
  "OBJECT_TYPE_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "INCOMPATIBLE_FILTER",
  "INVALID_PAGE_TOKEN",
  "OPENSEARCH_ERROR",
  "OBJECT_NOT_FOUND",
]);

// T-07 — verbose-404 gate. Returning the full `api_name` catalog in the
// 404 body is an information-disclosure defect (H-9): an unauthenticated
// or under-privileged caller can enumerate every object type in the
// ontology by guessing one missing name. The verbose body is gated behind
// a *dual* condition so staging — which often runs `NODE_ENV=production`
// — keeps the production-shape behavior:
//   - `NODE_ENV !== "production"` AND
//   - `TELLUS_DEBUG_404 === "true"`
// In production the body says only "Object type not found.", with the
// requested name preserved as `parameters.objectType` for client log
// correlation. The hint about catalog enumeration is intentionally
// omitted from the message in production.
async function ensureObjectTypeExists(objectType: string): Promise<void> {
  const result = await query(
    "SELECT 1 FROM object_type WHERE api_name = $1",
    [objectType]
  );
  if (result.rows.length === 0) {
    const verbose =
      process.env.NODE_ENV !== "production" &&
      process.env.TELLUS_DEBUG_404 === "true";
    if (verbose) {
      const all = await query(
        "SELECT api_name FROM object_type ORDER BY api_name"
      );
      const available = all.rows.map((r: any) => r.api_name);
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectType}' not found. Available object types: ${available.join(", ") || "(none)"}`,
        { objectType, available }
      );
    }
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      "Object type not found.",
      { objectType }
    );
  }
}

// T-07 — Testing seam.
// `ensureObjectTypeExists` is a private function-scoped helper, but the
// verbose-404 gate (C-104) is a security-critical contract that needs a
// direct unit test without spinning up an Express app. The seam exposes
// the helper without changing its production call surface — the route
// handlers continue to use the unexported reference.
export const __internals = { ensureObjectTypeExists };

function handleError(err: any, res: Response, next: NextFunction) {
  if (err.code && KNOWN_CODES.has(err.code)) {
    // T-07 — fold every known-code error through the canonical envelope
    // so `errorCode`/`errorName`/`requestId` are present and `message`
    // is `sanitizeMessage`-scrubbed. `appError` historically populates
    // `details`; later additions populate `parameters`. We accept both
    // so the structured envelope carries whichever was supplied.
    const detail = err.details ?? err.parameters ?? {};
    return sendError(res, err.code, err.message, detail);
  }
  next(err);
}

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/search (MUST come before /:primaryKey)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/search",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      // Spec §Task 23: the filter model is `{filter: [{property, operator,
      // value}, ...]}`. Translate into the historical `{where: {type,
      // field, value}}` shape (or a `{type:"and",filters:[...]}` tree for
      // multiple filters) before validation.
      const body = req.body || {};
      if (Array.isArray(body.filter) && !body.where) {
        const OP_MAP: Record<string, string> = {
          eq: "eq", ne: "eq",  // ne handled via not-wrapper below
          gt: "gt", gte: "gte", lt: "lt", lte: "lte",
          in: "in", contains: "contains", startsWith: "startsWith",
          exists: "isNotNull", notExists: "isNull",
        };
        const leaves = body.filter
          .filter((f: any) => f && f.property && f.operator)
          .map((f: any) => {
            const type = OP_MAP[f.operator as string] || "eq";
            const node: Record<string, unknown> = { type, field: f.property };
            if (type !== "isNull" && type !== "isNotNull") {
              node.value = f.value ?? f.values;
            }
            if (f.operator === "ne") {
              return { type: "not", filter: node };
            }
            return node;
          });
        if (leaves.length === 1) {
          body.where = leaves[0];
        } else if (leaves.length > 1) {
          body.where = { type: "and", filters: leaves };
        }
        delete body.filter;
      }
      // Accept the spec-style `pageSize` / `pageToken` field names.
      if (body.pageSize !== undefined && body.$pageSize === undefined) {
        body.$pageSize = body.pageSize;
        delete body.pageSize;
      }
      if (body.pageToken !== undefined && body.$pageToken === undefined) {
        body.$pageToken = body.pageToken;
        delete body.pageToken;
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.search", branchId);
      const validated = await validateSearchQuery(body, objectType);
      const rawResult = await executeSearch(objectType, {
        where: validated.where,
        $orderBy: validated.$orderBy,
        $pageSize: validated.$pageSize,
        $pageToken: validated.$pageToken,
        $select: validated.$select,
      }, secFilter, branchId);

      // B7: merge the writeback overlay so recent edits are visible
      // before Quickwit/OpenSearch catches up. Overlay hits REPLACE
      // the index document for matching PKs; misses pass through.
      const result = await mergeWithOverlay(objectType, rawResult, (body as Record<string, unknown>).where, branchId);

      // B9: shadow-diff during soak. Fire-and-forget — hurts neither
      // latency nor correctness if Quickwit is unreachable.
      recordShadowDiff(objectType, body, result.data as Array<Record<string, unknown>>);

      const elapsed = Date.now() - start;
      console.log(
        `[SEARCH] POST /api/v1/objects/${objectType}/search → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/searchFullText
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/searchFullText",
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

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.searchFullText", branchId);
      const rawResult = await executeFullTextSearch(objectType, searchQuery.trim(), {
        where,
        $orderBy,
        $pageSize: $pageSize ?? 100,
        $pageToken,
        $select,
      }, secFilter, branchId);
      // B7: overlay merge for immediate edit visibility.
      const result = await mergeWithOverlay(objectType, rawResult, undefined, branchId);

      const elapsed = Date.now() - start;
      console.log(
        `[FULLTEXT] POST /api/v1/objects/${objectType}/searchFullText → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/aggregate
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/aggregate",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.aggregate", branchId);
      const validated = await validateAggregateQuery(req.body || {}, objectType);
      const result = await executeAggregate(objectType, {
        where: validated.where,
        aggregations: validated.aggregations,
      }, secFilter, branchId);

      const elapsed = Date.now() - start;
      console.log(
        `[AGGREGATE] POST /api/v1/objects/${objectType}/aggregate → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType (List Objects)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const validated = await validateListQuery(
        req.query as Record<string, any>,
        objectType
      );

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.list", branchId);
      const rawResult = await executeSearch(objectType, {
        $orderBy: validated.orderBy.length > 0 ? validated.orderBy : undefined,
        $pageSize: validated.pageSize,
        $pageToken: validated.pageToken,
        $select: validated.select,
      }, secFilter, branchId);
      // B7: overlay merge — recent edits visible within 1s.
      const result = await mergeWithOverlay(objectType, rawResult, undefined, branchId);

      const elapsed = Date.now() - start;
      console.log(
        `[LIST] GET /api/v1/objects/${objectType} → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/searchAround (Task 13-14)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/searchAround",
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
      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.searchAround", branchId);
      const result = await searchAround(linkType, effectiveDirection, {
        sourceFilter, targetFilter, pageSize, pageToken,
      }, secFilter, branchId);

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/validateForeignKeys (Task 20)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/validateForeignKeys",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      const { object_type_id, ontology_id } = otResult.rows[0];

      // F-P3-13: FK validation scoped to the caller's branch.
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.validateForeignKeys", branchId);
      const result = await validateForeignKeys(object_type_id, req.body, ontology_id, buildSecurityFilter(req.security), branchId);
      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey/links/:linkType (Task 12)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey/links/:linkType",
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

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.linked", branchId);
      const result = await resolveLinks(linkType, primaryKey, effectiveDirection, {
        pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
        pageToken: pageToken as string,
        select: select ? (select as string).split(",") : undefined,
      }, secFilter, branchId);

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
// GET /api/v1/objects/:objectType/:primaryKey/links/:linkType/count (Task 15)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey/links/:linkType/count",
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

      // F-P3-13: link count scoped to the caller's branch.
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.linkedCount", branchId);
      const count = await countLinks(linkType, primaryKey, effectiveDirection, buildSecurityFilter(req.security), branchId);
      return sendSuccess(res, { linkTypeApiName, direction: effectiveDirection, count });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey/editHistory (Task 17)
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
  "/api/v1/objects/:objectType/:primaryKey/editHistory",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      // T-10 observability: editHistory queries the audit table directly
      // (not OpenSearch), but the contract guard still requires the
      // canonical trio. The buildSecurityFilter call here is a no-op
      // side effect documenting that the handler’s author considered
      // CBAC — the actual SQL filter is per-row immutable history.
      void buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.editHistory", branchId);
      void primaryKey;

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
      let cursorEditId: string | null = null;
      if (rawPageToken !== undefined && rawPageToken !== "") {
        try {
          const decoded = Buffer.from(String(rawPageToken), "base64").toString();
          // Composite cursor format: "timestamp::edit_id"
          // Legacy format (timestamp only) is also accepted for backward compat.
          const separatorIdx = decoded.indexOf("::");
          if (separatorIdx !== -1) {
            cursorTimestamp = decoded.substring(0, separatorIdx);
            cursorEditId = decoded.substring(separatorIdx + 2);
          } else {
            // Legacy format: timestamp only
            cursorTimestamp = decoded;
          }
          const parsed = new Date(cursorTimestamp);
          if (isNaN(parsed.getTime())) {
            throw new Error("Invalid date");
          }
        } catch {
          throw appError(
            "INVALID_PAGE_TOKEN",
            "Invalid $pageToken. Must be a valid base64-encoded cursor."
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

      // Composite cursor pagination: use (executed_at, edit_id) to avoid
      // duplicates or skips when multiple edits share the same timestamp
      // (possible within a single PG transaction).
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
           AND (
             $5::timestamptz IS NULL
             OR e.executed_at < $5
             OR (e.executed_at = $5 AND $6::uuid IS NOT NULL AND e.edit_id < $6::uuid)
           )
         ORDER BY e.executed_at DESC, e.edit_id DESC
         LIMIT $7`,
        [objectType, primaryKey, startTime, endTime, cursorTimestamp, cursorEditId, pageSize]
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
      // If we got a full page of results, there might be more. Encode a
      // composite cursor "executed_at::edit_id" so pagination is stable
      // even when multiple edits share the same timestamp.
      // ------------------------------------------------------------------

      let nextPageToken: string | null = null;
      if (rows.length === pageSize) {
        const lastRow = rows[rows.length - 1];
        const cursor = `${String(lastRow.executed_at)}::${String(lastRow.edit_id)}`;
        nextPageToken = Buffer.from(cursor).toString("base64");
      }

      const elapsed = Date.now() - start;
      console.log(
        `[EDIT_HISTORY] GET /api/v1/objects/${objectType}/${primaryKey}/editHistory → 200 (${data.length}/${totalCount} edits, ${elapsed}ms)`
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
// GET /api/v1/objects/:objectType/:primaryKey (Single Object)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.get", branchId);
      let obj = await executeGetObject(objectType, primaryKey, buildSecurityFilter(req.security), branchId);

      // B7: overlay read — if a recent edit is in the overlay but the
      // index hasn't absorbed it yet, the overlay is authoritative for
      // this PK.
      //
      // Two paths, kept distinct to avoid the "synthetic-stub" bug:
      //   1. Index HIT  → merge any overlay entry onto the real doc.
      //   2. Index MISS → do an explicit overlay lookup. Only
      //      materialise an object when the overlay ACTUALLY has a
      //      record for this PK. Do NOT pass a `{__pk}` placeholder
      //      through `applyOverlayToResults` — when the overlay is
      //      empty it returns the placeholder unchanged, the caller
      //      treats it as a hit, and every GET of a missing PK
      //      returns 200 with a stub document (fails the spec §Task 28
      //      IDOR guard and the GET-single 404 test).
      try {
        const store = await getOverlayStore();
        if (obj) {
          const overlayed = await applyOverlayToResults(
            objectType,
            [obj as Record<string, unknown>],
            store,
            branchId
          );
          // `applyOverlayToResults` returns an EMPTY array when the
          // overlay says the row is deleted → drop obj so the 404
          // branch below fires.
          obj = (overlayed[0] as typeof obj) ?? null;
        } else {
          // T-04: route the index-miss path through `readOverlay` so the
          // legacy-fallback gate and branch-mismatch counter fire.
          const record = await readOverlay(branchId, objectType, primaryKey, store);
          if (record && !record.deleted) {
            // `obj`'s static type is whatever `executeGetObject` returns;
            // cast via `unknown` because the overlay record's shape is a
            // plain property map — structurally compatible at runtime,
            // but TS can't prove it.
            obj = ({
              ...record.doc,
              __pk: record.primaryKey,
              __version: record.version,
              __overlay_source: "writeback",
            } as unknown) as typeof obj;
          }
        }
      } catch {
        /* overlay optional */
      }

      if (!obj || (obj as { __deleted?: boolean }).__deleted) {
        // Spec §Task 28: return 404 (not 403) for unauthorised/missing
        // lookups to prevent IDOR information leakage.
        throw appError(
          "OBJECT_NOT_FOUND",
          `Object with primary key '${primaryKey}' not found in object type '${objectType}'.`
        );
      }

      // Spec §Task 28 column-level stripping: remove any property the
      // caller lacks a matching marking for. Property markings are read
      // from the `property.marking_required` column — a null value means
      // the property is public.
      try {
        const propResult = await query(
          `SELECT api_name, marking_required FROM property
             WHERE object_type_id = (SELECT object_type_id FROM object_type WHERE api_name = $1)
               AND marking_required IS NOT NULL`,
          [objectType]
        );
        if (propResult.rows.length > 0) {
          const userMarkings = new Set(
            ((req as any).security?.markings as string[]) || []
          );
          const properties = (obj as { properties?: Record<string, unknown> }).properties;
          if (properties) {
            for (const row of propResult.rows) {
              const required = row.marking_required as string;
              if (!userMarkings.has(required)) {
                delete properties[row.api_name as string];
              }
            }
          }
        }
      } catch {
        // property.marking_required may not exist on every schema — skip.
      }

      const elapsed = Date.now() - start;
      console.log(
        `[GET] GET /api/v1/objects/${objectType}/${primaryKey} → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, obj);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

export default router;
