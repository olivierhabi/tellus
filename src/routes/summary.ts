// ---------------------------------------------------------------------------
// Lightweight Type Summary — Ontology Platform spec Task 19
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/summary
//   GET /:apiName   — return an under-1KB summary of an object type
//
// The explorer home page uses this to render preview popovers without
// fetching the full type payload.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const result = await query(
      `SELECT ot.api_name, ot.display_name, ot.description, ot.icon, ot.icon_color, ot.status,
              (SELECT COUNT(*)::int FROM property p WHERE p.object_type_id = ot.object_type_id) AS property_count
         FROM object_type ot
        WHERE ot.ontology_id = $1 AND ot.api_name = $2`,
      [ontologyId, apiName]
    );
    if (result.rowCount === 0) {
      return sendError(res, "OBJECT_TYPE_NOT_FOUND", `Object type ${apiName} not found.`);
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    // Home page bundle: object types, groups, favorites for the current user
    // in one round trip. Each section is capped so the total payload stays small.
    const userId = (req as any).user?.id || "system";
    const [types, groups, favorites, recent] = await Promise.all([
      query(
        "SELECT api_name, display_name, status FROM object_type WHERE ontology_id = $1 ORDER BY updated_at DESC LIMIT 20",
        [ontologyId]
      ),
      query(
        "SELECT api_name, display_name, icon FROM object_type_group WHERE ontology_id = $1 LIMIT 20",
        [ontologyId]
      ),
      query(
        "SELECT resource_type, resource_id FROM user_favorite WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
        [userId]
      ),
      query(
        "SELECT resource_type, resource_id, visited_at FROM user_recent_activity WHERE user_id = $1 ORDER BY visited_at DESC LIMIT 20",
        [userId]
      ),
    ]);
    sendSuccess(res, {
      objectTypes: types.rows,
      groups: groups.rows,
      favorites: favorites.rows,
      recent: recent.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
