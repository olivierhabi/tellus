// ---------------------------------------------------------------------------
// Branches / proposals / merge routes — Ontology Platform spec Task 9
// ---------------------------------------------------------------------------
// Mounted at: /api/v1/ontologies/:ontologyId/branches
//   POST   /                          — open a new branch
//   GET    /                          — list branches
//   GET    /:branchName               — get branch details
//   DELETE /:branchName               — close a branch
//   POST   /:branchName/merge         — merge a branch into its parent
//   POST   /:branchName/proposals     — open a proposal on a branch
//   POST   /:branchName/proposals/:id/approve — approve a proposal
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { OntologyError } from "../utils/queryErrors";

const router = Router({ mergeParams: true });

const MAX_OPEN_BRANCHES = 50;

const KNOWN = new Set([
  "BRANCH_NOT_FOUND",
  "API_NAME_CONFLICT",
  "BRANCH_MERGE_CONFLICT",
  "VALIDATION_FAILED",
  "INVALID_PARAMETER",
  "ONTOLOGY_NOT_FOUND",
]);

function appError(code: string, message: string): Error {
  const err = new Error(message);
  (err as any).code = code;
  return err;
}

// ---------------------------------------------------------------------------
// POST / — create branch
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { name, parentBranchName, description } = req.body || {};

    if (!name || typeof name !== "string") {
      throw appError("VALIDATION_FAILED", "Branch name is required.");
    }

    const existing = await query(
      "SELECT COUNT(*)::int AS n FROM ontology_branch WHERE ontology_id = $1 AND status = 'OPEN'",
      [ontologyId]
    );
    if (existing.rows[0].n >= MAX_OPEN_BRANCHES) {
      throw appError(
        "VALIDATION_FAILED",
        `Cannot exceed ${MAX_OPEN_BRANCHES} open branches per ontology.`
      );
    }

    let parentId: string | null = null;
    if (parentBranchName) {
      const parent = await query(
        "SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = $2",
        [ontologyId, parentBranchName]
      );
      if (parent.rowCount === 0) {
        throw appError(
          "BRANCH_NOT_FOUND",
          `Parent branch ${parentBranchName} not found.`
        );
      }
      parentId = parent.rows[0].branch_id;
    }

    const createdBy = (req as any).user?.id || "system";
    let row;
    try {
      const result = await query(
        `INSERT INTO ontology_branch
           (ontology_id, name, parent_branch_id, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [ontologyId, name, parentId, createdBy]
      );
      row = result.rows[0];
    } catch (err: any) {
      if (err.code === "23505") {
        throw appError(
          "API_NAME_CONFLICT",
          `Branch ${name} already exists in this ontology.`
        );
      }
      throw err;
    }

    sendCreated(res, { branch: row, description: description || null });
  } catch (err: any) {
    if (KNOWN.has(err.code)) return sendError(res, err.code, err.message);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET / — list branches
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { status } = req.query;
    const params: unknown[] = [ontologyId];
    let where = "ontology_id = $1";
    if (status && typeof status === "string") {
      params.push(status.toUpperCase());
      where += ` AND status = $${params.length}`;
    }
    const result = await query(
      `SELECT * FROM ontology_branch WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    sendSuccess(res, {
      data: result.rows,
      totalCount: result.rowCount,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:branchName — branch detail with proposals
// ---------------------------------------------------------------------------

router.get(
  "/:branchName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, branchName } = req.params;
      const branch = await query(
        "SELECT * FROM ontology_branch WHERE ontology_id = $1 AND name = $2",
        [ontologyId, branchName]
      );
      if (branch.rowCount === 0) {
        return sendError(
          res,
          "BRANCH_NOT_FOUND",
          `Branch ${branchName} not found.`
        );
      }
      const branchRow = branch.rows[0];
      const proposals = await query(
        "SELECT * FROM ontology_proposal WHERE branch_id = $1 ORDER BY created_at DESC",
        [branchRow.branch_id]
      );
      sendSuccess(res, { branch: branchRow, proposals: proposals.rows });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:branchName/merge — merge branch into parent
// ---------------------------------------------------------------------------

router.post(
  "/:branchName/merge",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, branchName } = req.params;
      const branch = await query(
        "SELECT * FROM ontology_branch WHERE ontology_id = $1 AND name = $2",
        [ontologyId, branchName]
      );
      if (branch.rowCount === 0) {
        return sendError(
          res,
          "BRANCH_NOT_FOUND",
          `Branch ${branchName} not found.`
        );
      }
      const row = branch.rows[0];
      if (row.status !== "OPEN") {
        return sendError(
          res,
          "VALIDATION_FAILED",
          `Branch is ${row.status}; only OPEN branches can be merged.`
        );
      }

      // Only approved proposals allow merging.
      const approved = await query(
        "SELECT COUNT(*)::int AS n FROM ontology_proposal WHERE branch_id = $1 AND status = 'APPROVED'",
        [row.branch_id]
      );
      if (approved.rows[0].n === 0) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "At least one APPROVED proposal is required before merging."
        );
      }

      await query(
        "UPDATE ontology_branch SET status = 'MERGED', merged_at = now() WHERE branch_id = $1",
        [row.branch_id]
      );
      await query(
        "UPDATE ontology_proposal SET status = 'MERGED', merged_at = now() WHERE branch_id = $1 AND status = 'APPROVED'",
        [row.branch_id]
      );

      sendSuccess(res, {
        branchId: row.branch_id,
        status: "MERGED",
      });
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:branchName/proposals — open a proposal
// ---------------------------------------------------------------------------

router.post(
  "/:branchName/proposals",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, branchName } = req.params;
      const { title, description } = req.body || {};
      if (!title) {
        return sendError(res, "VALIDATION_FAILED", "Proposal title is required.");
      }
      const branch = await query(
        "SELECT branch_id FROM ontology_branch WHERE ontology_id = $1 AND name = $2",
        [ontologyId, branchName]
      );
      if (branch.rowCount === 0) {
        return sendError(
          res,
          "BRANCH_NOT_FOUND",
          `Branch ${branchName} not found.`
        );
      }
      const createdBy = (req as any).user?.id || "system";
      const result = await query(
        `INSERT INTO ontology_proposal
           (branch_id, title, description, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [branch.rows[0].branch_id, title, description || null, createdBy]
      );
      sendCreated(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /:branchName/proposals/:proposalId/approve
// ---------------------------------------------------------------------------

router.post(
  "/:branchName/proposals/:proposalId/approve",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { proposalId } = req.params;
      const approvedBy = (req as any).user?.id || "system";
      const result = await query(
        `UPDATE ontology_proposal
            SET status = 'APPROVED', approved_by = $1, approved_at = now()
          WHERE proposal_id = $2 AND status = 'OPEN'
          RETURNING *`,
        [approvedBy, proposalId]
      );
      if (result.rowCount === 0) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "Proposal not found or already approved/closed."
        );
      }
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE /:branchName — close a branch
// ---------------------------------------------------------------------------

router.delete(
  "/:branchName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, branchName } = req.params;
      const result = await query(
        "UPDATE ontology_branch SET status = 'CLOSED' WHERE ontology_id = $1 AND name = $2 AND status = 'OPEN'",
        [ontologyId, branchName]
      );
      if (result.rowCount === 0) {
        return sendError(
          res,
          "BRANCH_NOT_FOUND",
          `Open branch ${branchName} not found.`
        );
      }
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
