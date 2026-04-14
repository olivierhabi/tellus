// ---------------------------------------------------------------------------
// Proposal Routes — Express Router
//
// CRUD for ontology change proposals. Table auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/proposals
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureProposalTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS proposal (
      proposal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id UUID NOT NULL,
      title       TEXT NOT NULL,
      description TEXT,
      branch_id   UUID,
      status      TEXT DEFAULT 'open',
      author      TEXT DEFAULT 'system',
      reviewer    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  migrated = true;
}

function formatRow(row: any) {
  return {
    proposalId: row.proposal_id,
    ontologyId: row.ontology_id,
    title: row.title,
    description: row.description,
    branchId: row.branch_id,
    status: row.status,
    author: row.author,
    reviewer: row.reviewer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET / — List proposals
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureProposalTable();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT * FROM proposal WHERE ontology_id = $1 ORDER BY created_at DESC`,
      [ontologyId]
    );

    return sendSuccess(res, { data: result.rows.map(formatRow) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a proposal
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureProposalTable();
    const { ontologyId } = req.params;
    const { title, description, branchId, author, reviewer } = req.body || {};

    if (!title) {
      return sendError(res, "VALIDATION_FAILED", "title is required.");
    }

    const result = await query(
      `INSERT INTO proposal (ontology_id, title, description, branch_id, author, reviewer)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ontologyId, title, description || null, branchId || null, author || "system", reviewer || null]
    );

    return sendCreated(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:proposalId — Update a proposal
// ---------------------------------------------------------------------------

router.put("/:proposalId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureProposalTable();
    const { ontologyId, proposalId } = req.params;
    const { title, description, status, reviewer } = req.body || {};

    const sets: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let idx = 1;

    if (title !== undefined) { sets.push(`title = $${idx++}`); values.push(title); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); values.push(description); }
    if (status !== undefined) { sets.push(`status = $${idx++}`); values.push(status); }
    if (reviewer !== undefined) { sets.push(`reviewer = $${idx++}`); values.push(reviewer); }

    values.push(proposalId, ontologyId);
    const result = await query(
      `UPDATE proposal SET ${sets.join(", ")} WHERE proposal_id = $${idx++} AND ontology_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Proposal '${proposalId}' not found.`);
    }

    return sendSuccess(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

export default router;
