// ---------------------------------------------------------------------------
// Webhook Routes — Express Router
//
// Side-effect webhooks for ontology events. Table auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/webhooks
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureWebhookTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS webhook (
      webhook_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id    UUID NOT NULL,
      action_type_id UUID,
      url            TEXT NOT NULL,
      event_type     TEXT NOT NULL,
      active         BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

// ---------------------------------------------------------------------------
// GET / — List webhooks
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureWebhookTable();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT * FROM webhook WHERE ontology_id = $1 ORDER BY created_at DESC`,
      [ontologyId]
    );

    const data = result.rows.map((row: any) => ({
      webhookId: row.webhook_id,
      ontologyId: row.ontology_id,
      actionTypeId: row.action_type_id,
      url: row.url,
      eventType: row.event_type,
      active: row.active,
      createdAt: row.created_at,
    }));

    return sendSuccess(res, { data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a webhook
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureWebhookTable();
    const { ontologyId } = req.params;
    const { actionTypeId, url, eventType, active } = req.body || {};

    if (!url || !eventType) {
      return sendError(res, "VALIDATION_FAILED", "url and eventType are required.");
    }

    const result = await query(
      `INSERT INTO webhook (ontology_id, action_type_id, url, event_type, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ontologyId, actionTypeId || null, url, eventType, active !== false]
    );

    const row = result.rows[0];
    return sendCreated(res, {
      webhookId: row.webhook_id,
      ontologyId: row.ontology_id,
      actionTypeId: row.action_type_id,
      url: row.url,
      eventType: row.event_type,
      active: row.active,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:webhookId — Delete a webhook
// ---------------------------------------------------------------------------

router.delete("/:webhookId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureWebhookTable();
    const { ontologyId, webhookId } = req.params;

    const result = await query(
      `DELETE FROM webhook WHERE webhook_id = $1 AND ontology_id = $2 RETURNING *`,
      [webhookId, ontologyId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Webhook '${webhookId}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
