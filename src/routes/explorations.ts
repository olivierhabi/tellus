// ---------------------------------------------------------------------------
// Saved Explorations — Ontology Platform spec Task 27
// ---------------------------------------------------------------------------
// CRUD endpoints for saved explorations:
//   POST   /        — create
//   GET    /        — list (scoped by owner + visibility)
//   GET    /:id     — get one
//   PUT    /:id     — update
//   DELETE /:id     — delete
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

function currentUser(req: Request): string {
  return (req as any).user?.id || "system";
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { title, description, config, visibility } = req.body || {};
    if (!title) {
      return sendError(res, "VALIDATION_FAILED", "title is required.");
    }
    const result = await query(
      `INSERT INTO saved_exploration
         (ontology_id, owner_id, title, description, config, visibility)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [
        ontologyId,
        currentUser(req),
        title,
        description || null,
        JSON.stringify(config || {}),
        visibility || "private",
      ]
    );
    sendCreated(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT * FROM saved_exploration
        WHERE ontology_id = $1
          AND (visibility IN ('shared','public') OR owner_id = $2)
        ORDER BY updated_at DESC`,
      [ontologyId, currentUser(req)]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      "SELECT * FROM saved_exploration WHERE exploration_id = $1",
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return sendError(res, "NOT_FOUND", "Exploration not found.");
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description, config, visibility } = req.body || {};
    const result = await query(
      `UPDATE saved_exploration
          SET title = COALESCE($2, title),
              description = COALESCE($3, description),
              config = COALESCE($4::jsonb, config),
              visibility = COALESCE($5, visibility),
              updated_at = now()
        WHERE exploration_id = $1 AND owner_id = $6
        RETURNING *`,
      [
        req.params.id,
        title,
        description,
        config ? JSON.stringify(config) : null,
        visibility,
        currentUser(req),
      ]
    );
    if (result.rowCount === 0) {
      return sendError(res, "NOT_FOUND", "Exploration not found or not owned by user.");
    }
    sendSuccess(res, result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(
      "DELETE FROM saved_exploration WHERE exploration_id = $1 AND owner_id = $2",
      [req.params.id, currentUser(req)]
    );
    sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
