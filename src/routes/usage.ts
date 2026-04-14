// ---------------------------------------------------------------------------
// Usage Tracking Routes — Express Router
//
// Log and query usage events. Table auto-created on first use.
//
// Endpoints:
//   POST /api/v2/usage                                  — Log usage event
//   GET  /api/v2/ontologies/:ontologyId/usage           — Query usage
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureUsageTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS usage_event (
      event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id   UUID,
      resource_type TEXT,
      resource_id   TEXT,
      user_id       TEXT DEFAULT 'system',
      operation     TEXT,
      app_id        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

// ---------------------------------------------------------------------------
// POST / — Log a usage event (mounted at /api/v2/usage)
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureUsageTable();
    const { ontologyId, resourceType, resourceId, userId, operation, appId } = req.body || {};

    if (!resourceType || !operation) {
      return sendError(res, "VALIDATION_FAILED", "resourceType and operation are required.");
    }

    const result = await query(
      `INSERT INTO usage_event (ontology_id, resource_type, resource_id, user_id, operation, app_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ontologyId || null, resourceType, resourceId || null, userId || "system", operation, appId || null]
    );

    const row = result.rows[0];
    return sendCreated(res, {
      eventId: row.event_id,
      ontologyId: row.ontology_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      userId: row.user_id,
      operation: row.operation,
      appId: row.app_id,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

export { router as usagePostRouter };

// ---------------------------------------------------------------------------
// GET /api/v2/ontologies/:ontologyId/usage — Query usage
// ---------------------------------------------------------------------------

const queryRouter = Router({ mergeParams: true });

queryRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureUsageTable();
    const { ontologyId } = req.params;
    const resource = req.query.resource as string | undefined;
    const days = parseInt((req.query.days as string) || "30", 10);

    const conditions = ["ontology_id = $1", "created_at >= NOW() - ($2 || ' days')::interval"];
    const values: unknown[] = [ontologyId, days];
    let idx = 3;

    if (resource) {
      conditions.push(`resource_type = $${idx++}`);
      values.push(resource);
    }

    const result = await query(
      `SELECT * FROM usage_event WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 500`,
      values
    );

    const data = result.rows.map((row: any) => ({
      eventId: row.event_id,
      ontologyId: row.ontology_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      userId: row.user_id,
      operation: row.operation,
      appId: row.app_id,
      createdAt: row.created_at,
    }));

    return sendSuccess(res, { data, totalCount: data.length });
  } catch (err) {
    next(err);
  }
});

export { queryRouter as usageQueryRouter };
export default router;
