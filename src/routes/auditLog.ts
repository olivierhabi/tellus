// ---------------------------------------------------------------------------
// Audit Log Routes
//
// REST API endpoints for querying the action audit log. These endpoints
// allow administrators and auditors to review all action executions — who
// did what, when, with what parameters, what was the result. For a tax
// authority system, this is legally mandatory — every data modification
// must be traceable.
//
// Two routers are exported:
//   1. actionAuditRouter — mounted at /api/v2/ontologies/:ontologyId/actions
//      GET /:actionTypeApiName/audit — audit log for a specific action type
//
//   2. globalAuditRouter — mounted at /api/v2/audit
//      GET /log                 — global audit log across all action types
//      GET /log/:executionId    — single audit entry by execution ID
//      GET /stats               — aggregate statistics
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendError } from "../utils/responseFormatter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Formatted audit log entry for API responses. */
interface FormattedAuditEntry {
  auditId: string;
  actionTypeApiName: string;
  actionTypeDisplayName: string;
  executionId: string;
  parameters: Record<string, unknown>;
  affectedObjects: unknown[];
  affectedObjectCount: number;
  result: string;
  failureType: string | null;
  errorMessage: string | null;
  durationMs: number;
  executedBy: string;
  executedAt: string;
  sourceIp: string | null;
  branchId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a raw DB row into a camelCase API response object. */
function formatAuditEntry(row: Record<string, any>): FormattedAuditEntry {
  return {
    auditId: row.audit_id,
    actionTypeApiName: row.action_type_api_name,
    actionTypeDisplayName: row.action_type_display_name,
    executionId: row.execution_id,
    parameters: row.parameters ?? {},
    affectedObjects: row.affected_objects ?? [],
    affectedObjectCount: row.affected_object_count ?? 0,
    result: row.result,
    failureType: row.failure_type ?? null,
    errorMessage: row.error_message ?? null,
    durationMs: row.duration_ms ?? 0,
    executedBy: row.executed_by,
    executedAt: row.executed_at,
    sourceIp: row.source_ip ?? null,
    branchId: row.branch_id ?? null,
  };
}

/** Valid result filter values. */
const VALID_RESULTS = new Set(["success", "failed", "partial"]);

/** Parse and clamp page size from query string. */
function parsePageSize(raw: unknown): number {
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n < 1) return 50;
  return Math.min(n, 1000);
}

/**
 * Decode a cursor-based page token. Returns the executed_at cursor string,
 * or null if the token is missing/invalid.
 */
function decodeCursorToken(token: unknown): string | null {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString());
    if (decoded.executed_at && typeof decoded.executed_at === "string") {
      return decoded.executed_at;
    }
    return null;
  } catch {
    return null;
  }
}

/** Encode an executed_at timestamp as a cursor page token. */
function encodeCursorToken(executedAt: string): string {
  return Buffer.from(
    JSON.stringify({ executed_at: executedAt })
  ).toString("base64");
}

// ---------------------------------------------------------------------------
// Shared query builder
// ---------------------------------------------------------------------------

interface AuditQueryParams {
  actionTypeApiName?: string;
  result?: string;
  startTime?: string;
  endTime?: string;
  executedBy?: string;
  cursor?: string | null;
  pageSize: number;
}

/**
 * Build and execute the audit log query with filters and pagination.
 * Returns { data, nextPageToken, totalCount }.
 */
async function queryAuditLog(params: AuditQueryParams): Promise<{
  data: FormattedAuditEntry[];
  nextPageToken: string | null;
  totalCount: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  // Filter conditions (shared between count and data queries)
  if (params.actionTypeApiName) {
    conditions.push(`action_type_api_name = $${paramIndex++}`);
    values.push(params.actionTypeApiName);
  }
  if (params.result) {
    conditions.push(`result = $${paramIndex++}`);
    values.push(params.result);
  }
  if (params.startTime) {
    conditions.push(`executed_at >= $${paramIndex++}`);
    values.push(params.startTime);
  }
  if (params.endTime) {
    conditions.push(`executed_at <= $${paramIndex++}`);
    values.push(params.endTime);
  }
  if (params.executedBy) {
    conditions.push(`executed_by = $${paramIndex++}`);
    values.push(params.executedBy);
  }

  // Save the filter-only state for the count query
  const countConditions = [...conditions];
  const countValues = [...values];

  // Count query (without cursor or LIMIT)
  const countWhere =
    countConditions.length > 0
      ? `WHERE ${countConditions.join(" AND ")}`
      : "";
  const countResult = await query(
    `SELECT COUNT(*)::int AS count FROM action_audit_log ${countWhere}`,
    countValues
  );
  const totalCount: number = countResult.rows[0].count;

  // Cursor pagination condition (only for the data query)
  if (params.cursor) {
    conditions.push(`executed_at < $${paramIndex++}`);
    values.push(params.cursor);
  }

  const dataWhere =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Fetch pageSize + 1 to determine if there's a next page
  values.push(params.pageSize + 1);
  const dataResult = await query(
    `SELECT * FROM action_audit_log ${dataWhere}
     ORDER BY executed_at DESC
     LIMIT $${paramIndex}`,
    values
  );

  const rows = dataResult.rows;
  let nextPageToken: string | null = null;

  if (rows.length > params.pageSize) {
    // There's a next page — remove the extra row
    rows.pop();
    // Token is the executed_at of the last entry in the current page
    const lastEntry = rows[rows.length - 1];
    nextPageToken = encodeCursorToken(lastEntry.executed_at);
  }

  const data = rows.map(formatAuditEntry);

  return { data, nextPageToken, totalCount };
}

// ---------------------------------------------------------------------------
// Router 1: Action-scoped audit routes
// ---------------------------------------------------------------------------

const actionAuditRouter = Router({ mergeParams: true });

/**
 * GET /:actionTypeApiName/audit
 *
 * Returns audit log entries for a specific action type.
 */
actionAuditRouter.get(
  "/:actionTypeApiName/audit",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actionTypeApiName } = req.params;

      if (!actionTypeApiName) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "actionTypeApiName is required"
        );
      }

      // Parse query parameters
      const pageSize = parsePageSize(req.query.$pageSize ?? req.query.pageSize);
      const cursor = decodeCursorToken(
        req.query.$pageToken ?? req.query.pageToken
      );

      const resultFilter = req.query.result as string | undefined;
      if (resultFilter && !VALID_RESULTS.has(resultFilter)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          `Invalid result filter '${resultFilter}'. Must be one of: success, failed, partial`
        );
      }

      const result = await queryAuditLog({
        actionTypeApiName,
        result: resultFilter,
        startTime: req.query.startTime as string | undefined,
        endTime: req.query.endTime as string | undefined,
        executedBy: req.query.executedBy as string | undefined,
        cursor,
        pageSize,
      });

      return res.status(200).json(result);
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Router 2: Global audit routes
// ---------------------------------------------------------------------------

const globalAuditRouter = Router();

/**
 * GET /log
 *
 * Returns the global audit log across all action types.
 */
globalAuditRouter.get(
  "/log",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageSize = parsePageSize(req.query.$pageSize ?? req.query.pageSize);
      const cursor = decodeCursorToken(
        req.query.$pageToken ?? req.query.pageToken
      );

      const resultFilter = req.query.result as string | undefined;
      if (resultFilter && !VALID_RESULTS.has(resultFilter)) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          `Invalid result filter '${resultFilter}'. Must be one of: success, failed, partial`
        );
      }

      const result = await queryAuditLog({
        actionTypeApiName: req.query.actionType as string | undefined,
        result: resultFilter,
        startTime: req.query.startTime as string | undefined,
        endTime: req.query.endTime as string | undefined,
        executedBy: req.query.executedBy as string | undefined,
        cursor,
        pageSize,
      });

      return res.status(200).json(result);
    } catch (err: any) {
      next(err);
    }
  }
);

/**
 * GET /log/:executionId
 *
 * Returns a single audit log entry by execution ID. Returns 404 if not found.
 */
globalAuditRouter.get(
  "/log/:executionId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { executionId } = req.params;

      if (!executionId) {
        return sendError(
          res,
          "INVALID_PARAMETER",
          "executionId is required"
        );
      }

      const result = await query(
        "SELECT * FROM action_audit_log WHERE execution_id = $1",
        [executionId]
      );

      if (result.rows.length === 0) {
        return sendError(
          res,
          "AUDIT_ENTRY_NOT_FOUND",
          `Audit log entry with execution ID '${executionId}' not found`
        );
      }

      return res.status(200).json(formatAuditEntry(result.rows[0]));
    } catch (err: any) {
      next(err);
    }
  }
);

/**
 * GET /stats
 *
 * Returns aggregate statistics about action executions.
 */
globalAuditRouter.get(
  "/stats",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Default time range: last 24 hours
      const now = new Date();
      const defaultStart = new Date(
        now.getTime() - 24 * 60 * 60 * 1000
      ).toISOString();

      const startTime = (req.query.startTime as string) || defaultStart;
      const endTime = (req.query.endTime as string) || now.toISOString();
      const actionType = req.query.actionType as string | undefined;

      // Build shared WHERE clause
      const conditions: string[] = [
        "executed_at >= $1",
        "executed_at <= $2",
      ];
      const values: unknown[] = [startTime, endTime];

      if (actionType) {
        conditions.push("action_type_api_name = $3");
        values.push(actionType);
      }

      const whereClause = `WHERE ${conditions.join(" AND ")}`;

      // Sub-query 1: Aggregate counts and timing
      const aggregateResult = await query(
        `SELECT
           COUNT(*)::int AS total_executions,
           COUNT(*) FILTER (WHERE result = 'success')::int AS success_count,
           COUNT(*) FILTER (WHERE result = 'failed')::int AS failed_count,
           COUNT(*) FILTER (WHERE result = 'partial')::int AS partial_count,
           COALESCE(ROUND(AVG(duration_ms))::int, 0) AS avg_duration_ms,
           COALESCE(
             ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::int,
             0
           ) AS p95_duration_ms
         FROM action_audit_log
         ${whereClause}`,
        values
      );

      const agg = aggregateResult.rows[0];

      // Sub-query 2: Failure breakdown
      const failureResult = await query(
        `SELECT failure_type, COUNT(*)::int AS count
         FROM action_audit_log
         ${whereClause} AND result = 'failed'
         GROUP BY failure_type
         ORDER BY count DESC`,
        values
      );

      const failureBreakdown: Record<string, number> = {};
      for (const row of failureResult.rows) {
        if (row.failure_type) {
          failureBreakdown[row.failure_type] = row.count;
        }
      }

      // Sub-query 3: Top 10 action types by execution count
      const topResult = await query(
        `SELECT
           action_type_api_name AS api_name,
           MAX(action_type_display_name) AS display_name,
           COUNT(*)::int AS count
         FROM action_audit_log
         ${whereClause}
         GROUP BY action_type_api_name
         ORDER BY count DESC
         LIMIT 10`,
        values
      );

      const topActionTypes = topResult.rows.map((row) => ({
        apiName: row.api_name as string,
        displayName: row.display_name as string,
        count: row.count as number,
      }));

      return res.status(200).json({
        period: { startTime, endTime },
        totalExecutions: agg.total_executions,
        results: {
          success: agg.success_count,
          failed: agg.failed_count,
          partial: agg.partial_count,
        },
        timing: {
          avgDurationMs: agg.avg_duration_ms,
          p95DurationMs: agg.p95_duration_ms,
        },
        failureBreakdown,
        topActionTypes,
      });
    } catch (err: any) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { actionAuditRouter, globalAuditRouter };
