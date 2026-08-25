// ---------------------------------------------------------------------------
// Branches / proposals / merge routes — Ontology Platform spec Task 9
// ---------------------------------------------------------------------------
// Mounted at: /api/v1/ontology/:ontologyId/branches
//   POST   /                          — open a new branch
//   GET    /                          — list branches
//   GET    /:branchName               — get branch details
//   DELETE /:branchName               — close a branch
//   POST   /:branchName/merge         — merge a branch into its parent
//   POST   /:branchName/proposals     — open a proposal on a branch
//   POST   /:branchName/proposals/:id/approve — approve a proposal
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query, getClient } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { OntologyError } from "../utils/queryErrors";
import { mergeThreeWay, getBranchDiff, recordForkPoint } from "../services/branchMergeService";

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
    // F-04: Use a transaction to atomically create the branch and record
    // the fork point (the latest edit_id at the time of fork).
    const pgClient = await getClient();
    try {
      await pgClient.query("BEGIN");
      const result = await pgClient.query(
        `INSERT INTO ontology_branch
           (ontology_id, name, parent_branch_id, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [ontologyId, name, parentId, createdBy]
      );
      row = result.rows[0];
      await recordForkPoint(pgClient, row.branch_id, ontologyId);
      await pgClient.query("COMMIT");
    } catch (err: any) {
      await pgClient.query("ROLLBACK").catch(() => {});
      if (err.code === "23505") {
        throw appError(
          "API_NAME_CONFLICT",
          `Branch ${name} already exists in this ontology.`
        );
      }
      throw err;
    } finally {
      pgClient.release();
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
      const { resolutions } = req.body || {};

      // Look up the branch
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

      // F-04: Three-way merge with conflict detection.
      // Convert resolutions from JSON object to Map if provided.
      let resolutionMap: Map<string, "parent" | "branch"> | undefined;
      if (resolutions && typeof resolutions === "object") {
        resolutionMap = new Map(
          Object.entries(resolutions) as Array<[string, "parent" | "branch"]>
        );
      }

      const mergeResult = await mergeThreeWay(
        ontologyId,
        row.branch_id,
        resolutionMap
      );

      if (!mergeResult.success) {
        // Conflicts detected — return 409 with conflict details.
        return res.status(409).json({
          error: {
            code: "BRANCH_MERGE_CONFLICT",
            message: `Merge conflict: ${mergeResult.conflicts.length} conflicting property change(s). Provide resolutions to proceed.`,
            conflicts: mergeResult.conflicts,
          },
        });
      }

      sendSuccess(res, {
        branchId: row.branch_id,
        status: "MERGED",
        mergedEditCount: mergeResult.mergedEditCount,
      });
    } catch (err: any) {
      if (KNOWN.has(err.code)) return sendError(res, err.code, err.message);
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

// ---------------------------------------------------------------------------
// POST /:branchName/apply-fast — B3 (cross-functionality engagement) scenario
// "apply" shim. Dev/test-only: gated by X-Tellus-Test-Hook:1 +
// NODE_ENV!=="production" (same posture as the auth login-bypass — not
// reachable in a production build). Auto-opens + approves a synthetic
// proposal + merges the branch into its parent so a Scenario ("apply") lands
// without the 3-step human proposal gate. Production keeps the human gate
// (POST /:branchName/proposals + /:proposalId/approve + /merge); this fast
// path is ONLY for the E2E engagement's scenario-apply step.
// ---------------------------------------------------------------------------
router.post(
  "/:branchName/apply-fast",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.NODE_ENV === "production" || req.headers["x-tellus-test-hook"] !== "1") {
        return sendError(res, "FORBIDDEN", "apply-fast is dev/test-only.");
      }
      const { ontologyId, branchName } = req.params;
      const branch = await query(
        "SELECT * FROM ontology_branch WHERE ontology_id = $1 AND name = $2",
        [ontologyId, branchName],
      );
      if (branch.rowCount === 0) {
        return sendError(res, "BRANCH_NOT_FOUND", `Branch ${branchName} not found.`);
      }
      const row = branch.rows[0];
      if (row.status !== "OPEN") {
        return sendError(res, "VALIDATION_FAILED", `Branch is ${row.status}; only OPEN branches can be applied.`);
      }
      // Open + auto-approve a synthetic proposal so the merge guard (>=1
      // APPROVED proposal) is satisfied.
      const createdBy = (req as any).user?.id || "system";
      const prop = await query(
        `INSERT INTO ontology_proposal (branch_id, title, description, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [row.branch_id, `apply-fast-${Date.now()}`, "Auto-approved by cross-functionality E2E shim.", createdBy],
      );
      const proposalId = prop.rows[0].proposal_id;
      await query(
        `UPDATE ontology_proposal SET status = 'APPROVED', approved_by = $1, approved_at = now()
         WHERE proposal_id = $2 AND status = 'OPEN'`,
        [createdBy, proposalId],
      );
      const mergeResult = await mergeThreeWay(ontologyId, row.branch_id, undefined);
      if (!mergeResult.success) {
        return res.status(409).json({
          error: { code: "BRANCH_MERGE_CONFLICT", message: `Merge conflict: ${mergeResult.conflicts.length}.`, conflicts: mergeResult.conflicts },
        });
      }
      sendSuccess(res, { branchId: row.branch_id, status: "MERGED", mergedEditCount: mergeResult.mergedEditCount });
    } catch (err: any) {
      if (KNOWN.has(err.code)) return sendError(res, err.code, err.message);
      next(err);
    }
  }
);

export default router;
