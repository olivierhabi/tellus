// ---------------------------------------------------------------------------
// Action Audit Log Model
//
// Data access layer for the immutable action_audit_log table. This table
// records every action execution attempt — successful or failed — with
// full parameter snapshots, affected objects, results, timing, and failure
// classification.
//
// The audit log is separate from the ontology_edit table:
//   - ontology_edit: the actual data changes (edits to objects)
//   - action_audit_log: metadata about the execution itself (who, when,
//     what parameters, what happened, how long, success/failure, why)
//
// IMPORTANT: logActionExecution() must NEVER throw — a failed audit log
// write should not cause the action itself to fail. If the insert fails,
// it logs to stderr and returns null.
//
// The table is immutable: no UPDATE or DELETE operations are permitted
// (enforced by REVOKE at the database level).
// ---------------------------------------------------------------------------

import { query } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid execution result values. */
export type AuditResult = "success" | "failed" | "partial";

/** Valid failure type values, matching Palantir's documented failure types. */
export type FailureType =
  | "invalid_parameter"
  | "scale_limit"
  | "authentication"
  | "object_not_found"
  | "duplicate_primary_key"
  | "required_property_missing"
  | "type_mismatch"
  | "side_effect"
  | "function_failure"
  | "unclassified";

/** A row from the action_audit_log table. */
export interface AuditLogRow {
  audit_id: string;
  action_type_api_name: string;
  action_type_display_name: string;
  execution_id: string;
  parameters: Record<string, unknown>;
  affected_objects: unknown[];
  affected_object_count: number;
  result: AuditResult;
  failure_type: FailureType | null;
  error_message: string | null;
  duration_ms: number;
  executed_by: string;
  executed_at: string;
  branch_id: string | null;
  source_ip: string | null;
  metadata: Record<string, unknown>;
}

/** Input for logActionExecution(). */
export interface LogActionExecutionInput {
  action_type_api_name: string;
  action_type_display_name: string;
  execution_id: string;
  parameters?: Record<string, unknown>;
  affected_objects?: unknown[];
  affected_object_count?: number;
  result: AuditResult;
  failure_type?: FailureType | null;
  error_message?: string | null;
  duration_ms?: number;
  executed_by?: string;
  branch_id?: string | null;
  source_ip?: string | null;
  metadata?: Record<string, unknown>;
}

/** Filters for getAuditLog(). */
export interface AuditLogFilters {
  actionTypeApiName?: string;
  executedBy?: string;
  result?: AuditResult;
  failureType?: FailureType;
  startTime?: string;
  endTime?: string;
  pageSize?: number;
  pageToken?: string;
}

/** Paginated result from getAuditLog(). */
export interface AuditLogPage {
  data: AuditLogRow[];
  nextPageToken: string | null;
  totalCount: number;
}

/** Aggregate statistics from getAuditStats(). */
export interface AuditStats {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  partialCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  failureBreakdown: Record<string, number>;
  topActionTypes: Array<{ apiName: string; count: number }>;
}

// ---------------------------------------------------------------------------
// 1. logActionExecution — Insert audit log record (never throws)
// ---------------------------------------------------------------------------

/**
 * Insert a new audit log record. This function must NEVER throw an error
 * that would prevent the caller from continuing. If the insert fails
 * (e.g., database connectivity issue), it logs the error to stderr and
 * returns null.
 *
 * Rationale: a failed audit log write should NOT cause the action itself
 * to fail. The action edits are more important than the audit metadata.
 * However, the caller SHOULD log a critical warning if this returns null.
 */
async function logActionExecution(
  logEntry: LogActionExecutionInput
): Promise<AuditLogRow | null> {
  try {
    const result = await query(
      `INSERT INTO action_audit_log
         (action_type_api_name, action_type_display_name, execution_id,
          parameters, affected_objects, affected_object_count,
          result, failure_type, error_message, duration_ms,
          executed_by, branch_id, source_ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        logEntry.action_type_api_name,
        logEntry.action_type_display_name,
        logEntry.execution_id,
        JSON.stringify(logEntry.parameters ?? {}),
        JSON.stringify(logEntry.affected_objects ?? []),
        logEntry.affected_object_count ?? 0,
        logEntry.result,
        logEntry.failure_type ?? null,
        logEntry.error_message ?? null,
        logEntry.duration_ms ?? 0,
        logEntry.executed_by ?? "system",
        logEntry.branch_id ?? null,
        logEntry.source_ip ?? null,
        JSON.stringify(logEntry.metadata ?? {}),
      ]
    );
    return result.rows[0] as AuditLogRow;
  } catch (err) {
    // CRITICAL: Do NOT re-throw. Log to stderr and return null.
    console.error(
      "CRITICAL: Failed to write action audit log entry:",
      {
        execution_id: logEntry.execution_id,
        action_type: logEntry.action_type_api_name,
        result: logEntry.result,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. getAuditLog — Query with filters and pagination
// ---------------------------------------------------------------------------

/**
 * Query the audit log with optional filters and cursor-based pagination.
 *
 * Pagination uses cursor-based approach with executed_at as the cursor,
 * encoded as a base64 page token. This is more efficient than OFFSET-based
 * pagination for large audit logs.
 *
 * Returns: { data, nextPageToken, totalCount }
 */
async function getAuditLog(
  filters: AuditLogFilters = {}
): Promise<AuditLogPage> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 1000);

  // Build WHERE clause dynamically
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (filters.actionTypeApiName) {
    conditions.push(`action_type_api_name = $${paramIndex++}`);
    values.push(filters.actionTypeApiName);
  }
  if (filters.executedBy) {
    conditions.push(`executed_by = $${paramIndex++}`);
    values.push(filters.executedBy);
  }
  if (filters.result) {
    conditions.push(`result = $${paramIndex++}`);
    values.push(filters.result);
  }
  if (filters.failureType) {
    conditions.push(`failure_type = $${paramIndex++}`);
    values.push(filters.failureType);
  }
  if (filters.startTime) {
    conditions.push(`executed_at >= $${paramIndex++}`);
    values.push(filters.startTime);
  }
  if (filters.endTime) {
    conditions.push(`executed_at <= $${paramIndex++}`);
    values.push(filters.endTime);
  }

  // Decode page token (cursor-based: executed_at of last result)
  if (filters.pageToken) {
    try {
      const decoded = JSON.parse(
        Buffer.from(filters.pageToken, "base64").toString()
      );
      if (decoded.cursor) {
        conditions.push(`executed_at < $${paramIndex++}`);
        values.push(decoded.cursor);
      }
    } catch {
      // Invalid page token — ignore and start from beginning
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total (without cursor pagination, but with other filters applied)
  const countConditions: string[] = [];
  const countValues: unknown[] = [];
  let countParamIndex = 1;

  if (filters.actionTypeApiName) {
    countConditions.push(`action_type_api_name = $${countParamIndex++}`);
    countValues.push(filters.actionTypeApiName);
  }
  if (filters.executedBy) {
    countConditions.push(`executed_by = $${countParamIndex++}`);
    countValues.push(filters.executedBy);
  }
  if (filters.result) {
    countConditions.push(`result = $${countParamIndex++}`);
    countValues.push(filters.result);
  }
  if (filters.failureType) {
    countConditions.push(`failure_type = $${countParamIndex++}`);
    countValues.push(filters.failureType);
  }
  if (filters.startTime) {
    countConditions.push(`executed_at >= $${countParamIndex++}`);
    countValues.push(filters.startTime);
  }
  if (filters.endTime) {
    countConditions.push(`executed_at <= $${countParamIndex++}`);
    countValues.push(filters.endTime);
  }

  const countWhereClause =
    countConditions.length > 0
      ? `WHERE ${countConditions.join(" AND ")}`
      : "";

  const countResult = await query(
    `SELECT COUNT(*)::int AS count FROM action_audit_log ${countWhereClause}`,
    countValues
  );
  const totalCount: number = countResult.rows[0].count;

  // Fetch data page
  values.push(pageSize);
  const dataResult = await query(
    `SELECT * FROM action_audit_log ${whereClause}
     ORDER BY executed_at DESC
     LIMIT $${paramIndex}`,
    values
  );

  const data = dataResult.rows as AuditLogRow[];

  // Compute next page token
  let nextPageToken: string | null = null;
  if (data.length === pageSize) {
    const lastEntry = data[data.length - 1];
    nextPageToken = Buffer.from(
      JSON.stringify({ cursor: lastEntry.executed_at })
    ).toString("base64");
  }

  return { data, nextPageToken, totalCount };
}

// ---------------------------------------------------------------------------
// 3. getAuditEntry — Get single entry by execution ID
// ---------------------------------------------------------------------------

/**
 * Get a single audit log entry by execution ID. Returns null if not found.
 */
async function getAuditEntry(
  executionId: string
): Promise<AuditLogRow | null> {
  const result = await query(
    "SELECT * FROM action_audit_log WHERE execution_id = $1",
    [executionId]
  );
  return result.rows.length > 0 ? (result.rows[0] as AuditLogRow) : null;
}

// ---------------------------------------------------------------------------
// 4. getAuditStats — Aggregate statistics for a time period
// ---------------------------------------------------------------------------

/**
 * Returns aggregate statistics for the given time period. Uses
 * PostgreSQL's PERCENTILE_CONT for p95 duration calculation.
 *
 * If actionTypeApiName is provided, filter stats to that action type only;
 * otherwise, return stats across all action types.
 *
 * Note: this function does NOT take an ontologyId parameter because the
 * action_audit_log table has no ontology_id column.
 */
async function getAuditStats(
  startTime: string,
  endTime: string,
  actionTypeApiName?: string
): Promise<AuditStats> {
  // Build the shared WHERE clause for all sub-queries
  const conditions: string[] = [
    "executed_at >= $1",
    "executed_at <= $2",
  ];
  const values: unknown[] = [startTime, endTime];

  if (actionTypeApiName) {
    conditions.push("action_type_api_name = $3");
    values.push(actionTypeApiName);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // --- Sub-query 1: Aggregate counts, avg duration, p95 duration ---
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

  // --- Sub-query 2: Failure breakdown ---
  const failureResult = await query(
    `SELECT failure_type, COUNT(*)::int AS count
     FROM action_audit_log
     ${whereClause} AND failure_type IS NOT NULL
     GROUP BY failure_type
     ORDER BY count DESC`,
    values
  );

  const failureBreakdown: Record<string, number> = {};
  for (const row of failureResult.rows) {
    failureBreakdown[row.failure_type] = row.count;
  }

  // --- Sub-query 3: Top 10 action types by execution count ---
  const topResult = await query(
    `SELECT action_type_api_name AS api_name, COUNT(*)::int AS count
     FROM action_audit_log
     ${whereClause}
     GROUP BY action_type_api_name
     ORDER BY count DESC
     LIMIT 10`,
    values
  );

  const topActionTypes = topResult.rows.map((row) => ({
    apiName: row.api_name as string,
    count: row.count as number,
  }));

  return {
    totalExecutions: agg.total_executions,
    successCount: agg.success_count,
    failedCount: agg.failed_count,
    partialCount: agg.partial_count,
    avgDurationMs: agg.avg_duration_ms,
    p95DurationMs: agg.p95_duration_ms,
    failureBreakdown,
    topActionTypes,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default {
  logActionExecution,
  getAuditLog,
  getAuditEntry,
  getAuditStats,
};

export {
  logActionExecution,
  getAuditLog,
  getAuditEntry,
  getAuditStats,
};
