// ---------------------------------------------------------------------------
// Saved Exploration Routes — Express Router
//
// CRUD for saved explorations. Table auto-created on first use.
//
// Mounted at: /api/v2/explorations
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureExplorationTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS saved_exploration (
      exploration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id    UUID,
      name           TEXT NOT NULL,
      description    TEXT,
      object_type    TEXT,
      filters        JSONB,
      layout         JSONB,
      visibility     TEXT DEFAULT 'private',
      created_by     TEXT DEFAULT 'system',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

function formatRow(row: any) {
  return {
    explorationId: row.exploration_id,
    ontologyId: row.ontology_id,
    name: row.name,
    description: row.description,
    objectType: row.object_type,
    filters: row.filters,
    layout: row.layout,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET / — List explorations
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureExplorationTable();

    const result = await query(
      `SELECT * FROM saved_exploration ORDER BY created_at DESC`
    );

    return sendSuccess(res, { data: result.rows.map(formatRow) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create an exploration
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureExplorationTable();
    const { ontologyId, name, description, objectType, filters, layout, visibility, createdBy } = req.body || {};

    if (!name) {
      return sendError(res, "VALIDATION_FAILED", "name is required.");
    }

    const result = await query(
      `INSERT INTO saved_exploration (ontology_id, name, description, object_type, filters, layout, visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [ontologyId || null, name, description || null, objectType || null, filters ? JSON.stringify(filters) : null, layout ? JSON.stringify(layout) : null, visibility || "private", createdBy || "system"]
    );

    return sendCreated(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:explorationId — Update an exploration
// ---------------------------------------------------------------------------

router.put("/:explorationId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureExplorationTable();
    const { explorationId } = req.params;
    const { name, description, objectType, filters, layout, visibility } = req.body || {};

    const sets: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); values.push(description); }
    if (objectType !== undefined) { sets.push(`object_type = $${idx++}`); values.push(objectType); }
    if (filters !== undefined) { sets.push(`filters = $${idx++}`); values.push(JSON.stringify(filters)); }
    if (layout !== undefined) { sets.push(`layout = $${idx++}`); values.push(JSON.stringify(layout)); }
    if (visibility !== undefined) { sets.push(`visibility = $${idx++}`); values.push(visibility); }

    values.push(explorationId);
    const result = await query(
      `UPDATE saved_exploration SET ${sets.join(", ")} WHERE exploration_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Exploration '${explorationId}' not found.`);
    }

    return sendSuccess(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:explorationId — Delete an exploration
// ---------------------------------------------------------------------------

router.delete("/:explorationId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureExplorationTable();
    const { explorationId } = req.params;

    const result = await query(
      `DELETE FROM saved_exploration WHERE exploration_id = $1 RETURNING *`,
      [explorationId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Exploration '${explorationId}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
