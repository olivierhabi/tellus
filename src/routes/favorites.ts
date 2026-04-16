// ---------------------------------------------------------------------------
// Favorites / Recent activity — Ontology Platform spec Task 14 (OMA)
// ---------------------------------------------------------------------------
// Mounted at /api/v1/users/me/favorites
//   POST   /                    — mark a resource as favorite
//   DELETE /:type/:id           — unfavorite
//   GET    /                    — list favorites for the current user
//   POST   /recent              — record a recent visit
//   GET    /recent              — list the 50 most recent items
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";

const router = Router();

const MAX_RECENTS = 50;

function currentUser(req: Request): string {
  return (req as any).user?.id || "system";
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { resourceType, resourceId } = req.body || {};
    if (!resourceType || !resourceId) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and resourceId required.");
    }
    await query(
      `INSERT INTO user_favorite (user_id, resource_type, resource_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [currentUser(req), resourceType, resourceId]
    );
    sendCreated(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete(
  "/:resourceType/:resourceId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await query(
        `DELETE FROM user_favorite
          WHERE user_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [currentUser(req), req.params.resourceType, req.params.resourceId]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      "SELECT resource_type, resource_id, created_at FROM user_favorite WHERE user_id = $1 ORDER BY created_at DESC",
      [currentUser(req)]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.post("/recent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { resourceType, resourceId } = req.body || {};
    if (!resourceType || !resourceId) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and resourceId required.");
    }
    const userId = currentUser(req);
    await query(
      `INSERT INTO user_recent_activity (user_id, resource_type, resource_id)
       VALUES ($1, $2, $3)`,
      [userId, resourceType, resourceId]
    );
    // Trim to the last MAX_RECENTS entries per user.
    await query(
      `DELETE FROM user_recent_activity
         WHERE id IN (
           SELECT id FROM user_recent_activity
            WHERE user_id = $1
            ORDER BY visited_at DESC
           OFFSET $2
         )`,
      [userId, MAX_RECENTS]
    );
    sendCreated(res, { ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/recent", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT resource_type, resource_id, visited_at
         FROM user_recent_activity
        WHERE user_id = $1
        ORDER BY visited_at DESC
        LIMIT $2`,
      [currentUser(req), MAX_RECENTS]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

export default router;
