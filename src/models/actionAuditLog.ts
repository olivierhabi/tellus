// ---------------------------------------------------------------------------
// src/models/actionAuditLog.ts
//
// Audit-log model — rewritten for F-P3-11.
//
// The previous contract stated: "logActionExecution() must NEVER throw —
// a failed audit log should not break the action pipeline." That
// contract is REVOKED. Durable-before-ack is now mandatory: a failed
// audit write MUST cause the Action's PG transaction to roll back and
// the client to see a 503, not a 200 with a silently dropped audit row.
//
// This file offers two entry points:
//
//   appendAuditRow(client, entry)
//     Invoked INSIDE an existing PG transaction — used as the
//     preCommitHook on applyEdits for success-path Actions. Writes the
//     audit row via insertAuditRowWithHashChain so the hash chain is
//     extended atomically with the Action's edits.
//
//   logStandaloneFailureAudit(entry)
//     Invoked when there IS no Action transaction — e.g. a Stage 1-5
//     validation failure that never reached editApplicator. Opens a
//     short-lived PG connection + transaction, appends a hash-chained
//     audit row, and commits. If that write fails, the function throws
//     — the route layer must translate to 503.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { getClient } from "../db";
import {
  insertAuditRowWithHashChain,
  AuditHashChainError,
  type AuditRowBody,
} from "../services/audit/hashChain";
import { incCounter } from "../services/funnel/metrics";
import { V1_DEFAULT_SEMANTICS } from "../actions/actionSemantics";

/** Result classification mirrored in DB CHECK (action_audit_log.result). */
export type AuditResult = "success" | "failed" | "partial";

/** Failure-type classification — used only when result != "success". */
export type FailureType =
  | "invalid_parameter"
  | "object_not_found"
  | "duplicate_primary_key"
  | "scale_limit"
  | "permission_denied"
  | "concurrency_conflict"
  // Phase 4 — writeback pre-edit stage rejection.
  | "writeback_rejected"
  | "unclassified"
  | null;

/**
 * Public-shape entry — what callers construct. The audit_id is
 * auto-generated inside this module so callers never have to coordinate
 * UUIDs with the hash-chain writer.
 */
export interface AuditLogEntry {
  action_type_api_name: string;
  action_type_display_name: string;
  execution_id: string;
  parameters: Record<string, unknown>;
  affected_objects: unknown[];
  affected_object_count: number;
  result: AuditResult;
  failure_type: FailureType;
  error_message: string | null;
  duration_ms: number;
  executed_by: string;
  source_ip?: string | null;
  branch_id?: string | null;
  metadata?: Record<string, unknown>;
  // Phase 8 — semantics audit fields (migration 121).
  semantics_version?: number | null;
  execution_mode?: string | null;
  correlation_id?: string | null;
}

/**
 * Raised when a standalone audit write fails. The route layer translates
 * this to a 503 Service Unavailable with Retry-After; the Action (if any
 * PG transaction was open) is already rolled back by the caller.
 */
export class AuditDurabilityError extends Error {
  public readonly code = "AUDIT_DURABILITY_FAILED";
  public readonly statusCode = 503;
  constructor(message: string, public readonly cause: unknown) {
    super(`audit durability failed: ${message}`);
    this.name = "AuditDurabilityError";
  }
}

function toRowBody(entry: AuditLogEntry): AuditRowBody {
  return {
    audit_id: randomUUID(),
    action_type_api_name: entry.action_type_api_name,
    action_type_display_name: entry.action_type_display_name,
    execution_id: entry.execution_id,
    parameters: entry.parameters ?? {},
    affected_objects: entry.affected_objects ?? [],
    affected_object_count: entry.affected_object_count,
    result: entry.result,
    failure_type: entry.failure_type ?? null,
    error_message: entry.error_message ?? null,
    duration_ms: entry.duration_ms,
    executed_by: entry.executed_by,
    executed_at: new Date().toISOString(),
    branch_id: entry.branch_id ?? null,
    source_ip: entry.source_ip ?? null,
    metadata: entry.metadata ?? {},
    // Migration 124 made action_audit_log.{semantics_version, execution_mode}
    // NOT NULL with domain CHECKs. Callers that predated the semantics
    // columns (or never resolved the action type's triple before a pipeline
    // failure) omit them; the honest mapping for such legacy rows is the
    // same v1 fallback resolveActionSemantics() applies to NULL stored rows
    // — audit and semantics answer "which semantics governed this execution"
    // identically.
    semantics_version:
      (entry as any).semantics_version ?? V1_DEFAULT_SEMANTICS.semanticsVersion,
    execution_mode:
      (entry as any).execution_mode ?? V1_DEFAULT_SEMANTICS.executionMode,
    correlation_id: (entry as any).correlation_id ?? null,
  };
}

/**
 * Append an audit row on an existing PG transaction. Intended as a
 * preCommitHook for applyEdits — the audit row is committed atomically
 * with the Action's edits.
 *
 * Throws if the hash-chain append fails. The caller MUST let that throw
 * propagate so the transaction rolls back (durable-before-ack).
 */
export async function appendAuditRow(
  client: PoolClient,
  entry: AuditLogEntry,
): Promise<{ auditId: string; rowHash: string }> {
  const body = toRowBody(entry);
  try {
    const { auditId, rowHash } = await insertAuditRowWithHashChain(client, body);
    return { auditId, rowHash };
  } catch (err) {
    // Observability: increment a counter so a chain-head-missing deploy
    // or an exhausted connection surfaces in Prometheus immediately.
    incCounter("tellus_action_audit_inline_failed_total", {
      reason: err instanceof AuditHashChainError ? err.code : "unknown",
    });
    throw err;
  }
}

/**
 * Write a standalone audit row for a failure that never entered an
 * Action transaction (Stage 1-5 pipeline errors). Opens its own PG
 * connection + transaction, appends via the hash chain, commits, and
 * releases the connection.
 *
 * Throws AuditDurabilityError on any failure — the route layer MUST
 * translate to 503.
 */
export async function logStandaloneFailureAudit(
  entry: AuditLogEntry,
): Promise<{ auditId: string; rowHash: string }> {
  const body = toRowBody(entry);
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const { auditId, rowHash } = await insertAuditRowWithHashChain(client, body);
    await client.query("COMMIT");
    return { auditId, rowHash };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    incCounter("tellus_action_audit_standalone_failed_total", {
      reason: err instanceof AuditHashChainError ? err.code : "unknown",
    });
    throw new AuditDurabilityError(
      err instanceof Error ? err.message : String(err),
      err,
    );
  } finally {
    client.release();
  }
}

/**
 * Legacy compatibility alias. Existing callers import `logActionExecution`
 * from this module; the new durable contract reaches them through the
 * standalone path. Throws on failure — the previous "NEVER throw"
 * contract is explicitly revoked per F-P3-11.
 */
export async function logActionExecution(
  entry: AuditLogEntry,
): Promise<{ auditId: string; rowHash: string }> {
  return logStandaloneFailureAudit(entry);
}

export default {
  appendAuditRow,
  logStandaloneFailureAudit,
  logActionExecution,
  AuditDurabilityError,
};
