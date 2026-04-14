// ---------------------------------------------------------------------------
// Favorites Routes — Express Router
//
// CRUD for user favorites (starred resources). The favorites table is
// auto-created on first use via CREATE TABLE IF NOT EXISTS.
//
// Mounted at: /api/v2/favorites
//
// Endpoints:
//   POST /           — Star a resource
//   GET  /           — List all favorites
//   DELETE /:favoriteId — Unstar a resource
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Auto-migration: ensure favorites table exists
// ---------------------------------------------------------------------------

let migrated = false;

async function ensureFavoritesTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS favorites (
      favorite_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      resource_type VARCHAR(50)  NOT NULL,
      resource_id   VARCHAR(255) NOT NULL,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE(resource_type, resource_id)
    )
  `);
  migrated = true;
}

// ---------------------------------------------------------------------------
// POST / — Star a resource
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFavoritesTable();

    const { resourceType, resourceId } = req.body || {};

    if (!resourceType || !resourceId) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and resourceId are required.");
    }

    const validTypes = ["objectType", "linkType", "actionType"];
    if (!validTypes.includes(resourceType)) {
      return sendError(res, "VALIDATION_FAILED", `resourceType must be one of: ${validTypes.join(", ")}.`);
    }

    const result = await query(
      `INSERT INTO favorites (resource_type, resource_id)
       VALUES ($1, $2)
       ON CONFLICT (resource_type, resource_id) DO UPDATE SET created_at = favorites.created_at
       RETURNING *`,
      [resourceType, resourceId]
    );

    const row = result.rows[0];
    return sendCreated(res, {
      favoriteId: row.favorite_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET / — List all favorites
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFavoritesTable();

    const result = await query(
      `SELECT * FROM favorites ORDER BY created_at DESC`
    );

    const data = result.rows.map((row: any) => ({
      favoriteId: row.favorite_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      createdAt: row.created_at,
    }));

    return sendSuccess(res, { data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:favoriteId — Unstar a resource
// ---------------------------------------------------------------------------

router.delete("/:favoriteId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFavoritesTable();

    const { favoriteId } = req.params;

    const result = await query(
      `DELETE FROM favorites WHERE favorite_id = $1 RETURNING *`,
      [favoriteId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Favorite '${favoriteId}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
