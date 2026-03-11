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
