// ---------------------------------------------------------------------------
// Branch Routes — Express Router
//
// CRUD for ontology branches. The branch table is auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/branches
//
// Endpoints:
//   GET  /              — List branches
//   POST /              — Create a branch
//   PUT  /:branchId     — Update a branch
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Auto-migration: ensure branch table exists
// ---------------------------------------------------------------------------

let migrated = false;

async function ensureBranchTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS ontology_branch (
      branch_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id   UUID NOT NULL,
      name          TEXT NOT NULL,
      parent_branch TEXT DEFAULT 'main',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_default    BOOLEAN DEFAULT false,
      UNIQUE(ontology_id, name)
    )
  `);
  migrated = true;
}

// ---------------------------------------------------------------------------
// GET / — List branches
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureBranchTable();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT * FROM ontology_branch WHERE ontology_id = $1 ORDER BY created_at DESC`,
      [ontologyId]
    );

    const data = result.rows.map((row: any) => ({
      branchId: row.branch_id,
      ontologyId: row.ontology_id,
      name: row.name,
      parentBranch: row.parent_branch,
      createdAt: row.created_at,
      isDefault: row.is_default,
    }));

    return sendSuccess(res, { data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a branch
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureBranchTable();
    const { ontologyId } = req.params;
    const { name, parentBranch, isDefault } = req.body || {};

    if (!name) {
      return sendError(res, "VALIDATION_FAILED", "name is required.");
    }

    const result = await query(
      `INSERT INTO ontology_branch (ontology_id, name, parent_branch, is_default)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [ontologyId, name, parentBranch || "main", isDefault || false]
    );

    const row = result.rows[0];
    return sendCreated(res, {
      branchId: row.branch_id,
      ontologyId: row.ontology_id,
      name: row.name,
      parentBranch: row.parent_branch,
      createdAt: row.created_at,
      isDefault: row.is_default,
    });
  } catch (err: any) {
    if (err.code === "23505") {
      return sendError(res, "ALREADY_EXISTS", "A branch with that name already exists.");
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:branchId — Update a branch
// ---------------------------------------------------------------------------

router.put("/:branchId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureBranchTable();
    const { ontologyId, branchId } = req.params;
    const { name, isDefault } = req.body || {};

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(name);
    }
    if (isDefault !== undefined) {
      sets.push(`is_default = $${idx++}`);
      values.push(isDefault);
    }

    if (sets.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "At least one field must be provided for update.");
    }

    values.push(branchId, ontologyId);
    const result = await query(
      `UPDATE ontology_branch SET ${sets.join(", ")} WHERE branch_id = $${idx++} AND ontology_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Branch '${branchId}' not found.`);
    }

    const row = result.rows[0];
    return sendSuccess(res, {
      branchId: row.branch_id,
      ontologyId: row.ontology_id,
      name: row.name,
      parentBranch: row.parent_branch,
      createdAt: row.created_at,
      isDefault: row.is_default,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
