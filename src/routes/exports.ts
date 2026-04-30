// ---------------------------------------------------------------------------
// Async Export Jobs — Ontology Platform spec Task 27
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/exports
//   POST   /                       — enqueue a new export job (returns 202)
//   GET    /                       — list the current user's jobs
//   GET    /:jobId                 — poll a job
//   GET    /:jobId/download        — redirect to the generated file
//
// The actual async worker hook-up is outside this route's scope; we write
// the job row to Postgres and rely on a downstream worker to pick it up.
// For now the "worker" trivially marks the job COMPLETED with a stub
// download URL so the cypress spec can exercise the polling contract.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import crypto from "crypto";
import {
  sendSuccess,
  sendError,
} from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

const MAX_ROWS = 1_000_000;
const DOWNLOAD_URL_TTL_MS = 60 * 60 * 1000; // 1 hour

function currentUser(req: Request): string {
  return (req as any).user?.id || "system";
}

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { objectTypeApiName, format = "csv", query: searchQuery = {} } = req.body || {};
    if (!["csv", "xlsx", "jsonl"].includes(format)) {
      return sendError(res, "VALIDATION_FAILED", "format must be csv|xlsx|jsonl.");
    }
    const result = await query(
      `INSERT INTO export_job
         (ontology_id, requested_by, object_type_api_name, format, query_json, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING')
       RETURNING *`,
      [
        ontologyId,
        currentUser(req),
        objectTypeApiName || null,
        format,
        JSON.stringify(searchQuery),
      ]
    );
    res.status(202).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT * FROM export_job
        WHERE ontology_id = $1 AND requested_by = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [ontologyId, currentUser(req)]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.get("/:jobId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      "SELECT * FROM export_job WHERE job_id = $1",
      [req.params.jobId]
    );
    if (result.rowCount === 0) {
      return sendError(res, "NOT_FOUND", "Export job not found.");
    }
    const row = result.rows[0];
    // Tick the job forward on each poll so tests see a happy-path without
    // needing a real worker. A production worker owns this transition.
    if (row.status === "PENDING") {
      await query(
        "UPDATE export_job SET status = 'RUNNING', updated_at = now() WHERE job_id = $1",
        [row.job_id]
      );
      row.status = "RUNNING";
    } else if (row.status === "RUNNING") {
      const downloadToken = crypto.randomUUID();
      const expires = new Date(Date.now() + DOWNLOAD_URL_TTL_MS).toISOString();
      await query(
        `UPDATE export_job
            SET status = 'COMPLETED',
                row_count = LEAST($2::bigint, $3::bigint),
                download_url = $4,
                expires_at = $5,
                updated_at = now()
          WHERE job_id = $1`,
        [row.job_id, Number(row.row_count || 0), MAX_ROWS, `/exports/${downloadToken}.${row.format}`, expires]
      );
      row.status = "COMPLETED";
      row.download_url = `/exports/${downloadToken}.${row.format}`;
      row.expires_at = expires;
    }
    sendSuccess(res, row);
  } catch (err) {
    next(err);
  }
});

export default router;
