// ---------------------------------------------------------------------------
// Security Policy Routes — Express Router
//
// CRUD for security policies. Table auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/security-policies
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensurePolicyTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS security_policy (
      policy_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id           UUID NOT NULL,
      object_type_api_name  TEXT,
      policy_type           TEXT NOT NULL CHECK(policy_type IN ('row_level','column_level','role')),
      config                JSONB,
      active                BOOLEAN DEFAULT true,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

function formatRow(row: any) {
  return {
    policyId: row.policy_id,
    ontologyId: row.ontology_id,
    objectTypeApiName: row.object_type_api_name,
    policyType: row.policy_type,
    config: row.config,
    active: row.active,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// GET / — List policies
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensurePolicyTable();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT * FROM security_policy WHERE ontology_id = $1 ORDER BY created_at DESC`,
      [ontologyId]
    );

    return sendSuccess(res, { data: result.rows.map(formatRow) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a policy
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensurePolicyTable();
    const { ontologyId } = req.params;
    const { objectTypeApiName, policyType, config, active } = req.body || {};

    if (!policyType) {
      return sendError(res, "VALIDATION_FAILED", "policyType is required (row_level, column_level, or role).");
    }

    const validTypes = ["row_level", "column_level", "role"];
    if (!validTypes.includes(policyType)) {
      return sendError(res, "VALIDATION_FAILED", `policyType must be one of: ${validTypes.join(", ")}.`);
    }

    const result = await query(
      `INSERT INTO security_policy (ontology_id, object_type_api_name, policy_type, config, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ontologyId, objectTypeApiName || null, policyType, config ? JSON.stringify(config) : null, active !== false]
    );

    return sendCreated(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:policyId — Update a policy
// ---------------------------------------------------------------------------

router.put("/:policyId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensurePolicyTable();
    const { ontologyId, policyId } = req.params;
    const { objectTypeApiName, policyType, config, active } = req.body || {};

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (objectTypeApiName !== undefined) { sets.push(`object_type_api_name = $${idx++}`); values.push(objectTypeApiName); }
    if (policyType !== undefined) { sets.push(`policy_type = $${idx++}`); values.push(policyType); }
    if (config !== undefined) { sets.push(`config = $${idx++}`); values.push(JSON.stringify(config)); }
    if (active !== undefined) { sets.push(`active = $${idx++}`); values.push(active); }

    if (sets.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "At least one field must be provided.");
    }

    values.push(policyId, ontologyId);
    const result = await query(
      `UPDATE security_policy SET ${sets.join(", ")} WHERE policy_id = $${idx++} AND ontology_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Policy '${policyId}' not found.`);
    }

    return sendSuccess(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:policyId — Delete a policy
// ---------------------------------------------------------------------------

router.delete("/:policyId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensurePolicyTable();
    const { ontologyId, policyId } = req.params;

    const result = await query(
      `DELETE FROM security_policy WHERE policy_id = $1 AND ontology_id = $2 RETURNING *`,
      [policyId, ontologyId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Policy '${policyId}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
