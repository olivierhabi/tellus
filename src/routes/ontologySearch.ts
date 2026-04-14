// ---------------------------------------------------------------------------
// Global Search Route — Express Router
//
// Provides a cross-resource search endpoint that queries object types,
// link types, and action types by display_name or api_name using ILIKE.
//
// Mounted at: /api/v2/search
//
// Endpoints:
//   GET /?q=...&types=objectType,linkType,actionType
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

const VALID_TYPES = new Set(["objectType", "linkType", "actionType"]);

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = req.query.q as string | undefined;

    if (!q || q.trim().length === 0) {
      return sendError(res, "VALIDATION_FAILED", "Query parameter 'q' is required.");
    }

    const pattern = `%${q.trim()}%`;

    // Parse requested types (default: all)
    const rawTypes = req.query.types as string | undefined;
    const requestedTypes: Set<string> = rawTypes
      ? new Set(rawTypes.split(",").map((t) => t.trim()).filter((t) => VALID_TYPES.has(t)))
      : new Set(VALID_TYPES);

    if (requestedTypes.size === 0) {
      return sendError(res, "VALIDATION_FAILED", "No valid types specified. Use: objectType, linkType, actionType.");
    }

    const results: Record<string, unknown[]> = {
      objectTypes: [],
      linkTypes: [],
      actionTypes: [],
    };

    // Search object types
    if (requestedTypes.has("objectType")) {
      const otResult = await query(
        `SELECT * FROM object_type
         WHERE display_name ILIKE $1 OR api_name ILIKE $1
         ORDER BY display_name
         LIMIT 50`,
        [pattern]
      );
      results.objectTypes = otResult.rows;
    }

    // Search link types
    if (requestedTypes.has("linkType")) {
      const ltResult = await query(
        `SELECT * FROM link_type
         WHERE display_name ILIKE $1 OR api_name ILIKE $1
         ORDER BY display_name
         LIMIT 50`,
        [pattern]
      );
      results.linkTypes = ltResult.rows;
    }

    // Search action types
    if (requestedTypes.has("actionType")) {
      const atResult = await query(
        `SELECT * FROM action_type
         WHERE display_name ILIKE $1 OR api_name ILIKE $1
         ORDER BY display_name
         LIMIT 50`,
        [pattern]
      );
      results.actionTypes = atResult.rows;
    }

    return sendSuccess(res, results);
  } catch (err) {
    next(err);
  }
});

export default router;
