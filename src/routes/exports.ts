// ---------------------------------------------------------------------------
// Async Export Jobs — Object Explorer T-05.
//
// Mounted at /api/v1/ontology/:ontologyId/exports
//   POST   /                       — enqueue a new export job (returns 202)
//   GET    /                       — list the current user's jobs
//   GET    /:jobId                 — poll a job
//   GET    /:jobId/download        — fetch the presigned download URL
//
// Security model (T-05 phase A):
//   * Every read on `export_job` is scoped to `requested_by = currentUser`.
//     A pre-T-05 IDOR allowed any authenticated caller to fetch any job
//     by id; the new shape returns 404 (not 403) when the job is missing
//     OR not owned by the caller, so we never leak existence.
//   * Job creation snapshots the caller's `SecurityContext` and active
//     branch id into `security_context_snapshot` / `branch_id_snapshot`
//     on the row. The Temporal worker (phase B) restores those values
//     before streaming any rows; the caller's session may be expired by
//     the time the worker runs, so the worker MUST NOT trust ambient
//     state.
//   * Downloads return the presigned URL, or 410 (`EXPORT_DOWNLOAD_EXPIRED`)
//     once `download_url_expires_at` is in the past, or 501
//     (`EXPORT_NOT_AVAILABLE`) while the job is still PENDING/RUNNING.
//
// Validation:
//   * `format` must be one of csv|jsonl|xlsx (the constants module is the
//     source of truth — keep this list aligned with `assertSupportedFormat`).
//   * `objectTypeApiName`, when provided, must be a non-empty string.
//   * `query` must be a JSON object (not an array, not a primitive).
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { currentUser } from "../middleware/currentUser";
import { requireSecurityContext } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";
import { routeMetric } from "../utils/routeInstrumentation";

const router = Router({ mergeParams: true });

const SUPPORTED_FORMATS = new Set(["csv", "jsonl", "xlsx"]);

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const format = typeof body.format === "string" ? body.format : "csv";
    const objectTypeApiName =
      typeof body.objectTypeApiName === "string" && body.objectTypeApiName.length > 0
        ? body.objectTypeApiName
        : null;
    const rawQuery = body.query;
    const queryJson =
      rawQuery && typeof rawQuery === "object" && !Array.isArray(rawQuery)
        ? (rawQuery as Record<string, unknown>)
        : {};

    if (!SUPPORTED_FORMATS.has(format)) {
      return sendError(
        res,
        "VALIDATION_ERROR",
        "format must be one of csv|jsonl|xlsx.",
        { field: "format", received: format },
      );
    }
    if (
      body.objectTypeApiName !== undefined &&
      body.objectTypeApiName !== null &&
      typeof body.objectTypeApiName !== "string"
    ) {
      return sendError(
        res,
        "VALIDATION_ERROR",
        "objectTypeApiName must be a string when provided.",
        { field: "objectTypeApiName" },
      );
    }
    if (
      rawQuery !== undefined &&
      (rawQuery === null ||
        typeof rawQuery !== "object" ||
        Array.isArray(rawQuery))
    ) {
      return sendError(
        res,
        "VALIDATION_ERROR",
        "query must be a JSON object.",
        { field: "query" },
      );
    }

    // The security snapshot is the contract that lets the worker run
    // *as if it were the requester* without trusting the worker host's
    // ambient session. requireSecurityContext throws SECURITY_CONTEXT_MISSING
    // (500) if the middleware did not populate `req.security` — that is
    // intentional fail-closed behaviour.
    const securityContext = requireSecurityContext(req);
    const branchId = readBranchHeader(req);
    routeMetric(req, "exports.create", branchId);

    const result = await query(
      `INSERT INTO export_job
         (ontology_id, requested_by, object_type_api_name,
          format, query_json, status,
          security_context_snapshot, branch_id_snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', $6::jsonb, $7)
       RETURNING job_id, ontology_id, requested_by, object_type_api_name,
                 format, status, created_at`,
      [
        ontologyId,
        currentUser(req),
        objectTypeApiName,
        format,
        JSON.stringify(queryJson),
        JSON.stringify(securityContext),
        branchId,
      ],
    );
    incCounter("tellus_export_jobs_total", { format, outcome: "enqueued" });
    res.status(202).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    routeMetric(req, "exports.list", null);
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT job_id, ontology_id, requested_by, object_type_api_name,
              format, status, created_at, completed_at, failed_at,
              row_count, failure_reason
         FROM export_job
        WHERE ontology_id = $1 AND requested_by = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [ontologyId, currentUser(req)],
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/:jobId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      routeMetric(req, "exports.get", null);
      const result = await query(
        `SELECT job_id, ontology_id, requested_by, object_type_api_name,
                format, status, created_at, started_at, completed_at,
                failed_at, row_count, failure_reason,
                download_url_expires_at
           FROM export_job
          WHERE job_id = $1 AND requested_by = $2`,
        [req.params.jobId, currentUser(req)],
      );
      if (result.rowCount === 0) {
        return sendError(res, "NOT_FOUND", "Export job not found.");
      }
      sendSuccess(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/:jobId/download",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      routeMetric(req, "exports.download", null);
      const result = await query(
        `SELECT status, download_url, download_url_expires_at, format
           FROM export_job
          WHERE job_id = $1 AND requested_by = $2`,
        [req.params.jobId, currentUser(req)],
      );
      if (result.rowCount === 0) {
        return sendError(res, "NOT_FOUND", "Export job not found.");
      }
      const row = result.rows[0] as {
        status: string;
        download_url: string | null;
        download_url_expires_at: Date | string | null;
        format: string;
      };
      if (row.status !== "COMPLETED" || !row.download_url) {
        return sendError(
          res,
          "EXPORT_NOT_AVAILABLE",
          "Export is not ready yet.",
          { status: row.status },
        );
      }
      const expiresAt = row.download_url_expires_at
        ? new Date(row.download_url_expires_at)
        : null;
      if (expiresAt && expiresAt.getTime() < Date.now()) {
        incCounter("tellus_export_download_expired_total", {
          format: row.format,
        });
        return sendError(
          res,
          "EXPORT_DOWNLOAD_EXPIRED",
          "Download URL has expired; please re-run the export.",
          { expiresAt: expiresAt.toISOString() },
        );
      }
      incCounter("tellus_export_download_issued_total", {
        format: row.format,
      });
      sendSuccess(res, {
        downloadUrl: row.download_url,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
