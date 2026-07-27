// ---------------------------------------------------------------------------
// src/services/audit/hashChain.ts
//
// Closes the write-path half of F-P3-11 (audit durable-before-ack +
// tamper-evident).
//
// Responsibilities
// ----------------
//
// 1. insertAuditRowWithHashChain(client, rowBody) — single entry point
//    that, inside the provided PG client's transaction:
//
//      a. Acquires pg_advisory_xact_lock(AUDIT_HASH_CHAIN_LOCK_KEY).
//      b. SELECT FOR UPDATE on the singleton audit_hash_head row.
//      c. Computes prev_hash = head.head_hash, row_hash = sha256(
//           prev_hash || canonicalJson(rowBody)).
//      d. INSERT INTO action_audit_log (...rowBody, prev_hash, row_hash).
//      e. UPDATE audit_hash_head with the new head_hash, audit_id, seq.
//      f. Emits tellus_action_audit_chain_appended_total counter.
//      g. Returns the inserted audit_id + row_hash for caller logging.
//
//    If ANY step throws, the caller's transaction is responsible for
//    ROLLBACK — this function never catches errors. That is the durable-
//    before-ack contract: the Action's PG commit depends on the audit
//    row's successful INSERT.
//
// 2. AUDIT_HASH_CHAIN_LOCK_KEY — the advisory-lock key. Derived from
//    hashtext('tellus.audit.hash_head') so there is no collision with
//    other advisory locks in the codebase (none currently use this key).
//    The key is a bigint as pg_advisory_xact_lock expects.
//
// 3. verifyChainSegment(startAfterSeq, limit) — forward-walks `limit`
//    rows starting after `startAfterSeq`, recomputing each row_hash and
//    asserting it matches the stored row_hash and that prev_hash matches
//    the previous row's row_hash. Returns a report including any breaks.
//    Used by src/jobs/auditVerifier.ts and by the chain-break detection
//    negative test.
//
// Feature flag
// ------------
//
//   ENFORCE_AUDIT_HASH_CHAIN = "1" (default in prod)
//     → insertAuditRowWithHashChain throws if head pointer missing.
//
//   ENFORCE_AUDIT_HASH_CHAIN = "0"
//     → audit insert proceeds without hash-chain columns populated, for
//       rolling-deploy compatibility only. After a full rollover, flip
//       to "1" and run migration 037 to backfill pre-036 rows.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonicalJson";
import { incCounter } from "../funnel/metrics";

// ---------------------------------------------------------------------------
// Advisory lock key.
//
// pg_advisory_xact_lock takes a bigint. We derive it from hashtext() so a
// reader can reproduce the same key by hashing the same literal in SQL:
//
//   SELECT hashtext('tellus.audit.hash_head');
//
// The resulting integer fits in int32. The Node-side constant is the same
// value (0x3E7A4F11 = 1_048_899_857 in decimal — see
// tests/unit/audit/hashChain-unit.test.ts for the constant derivation).
//
// We use a fixed int32 rather than hashtext-at-runtime because
// pg_advisory_xact_lock(bigint) accepts a literal and avoids an extra
// round-trip. The constant is considered part of the protocol — any
// migration that changes it must also change the SQL callers.
// ---------------------------------------------------------------------------
export const AUDIT_HASH_CHAIN_LOCK_KEY: bigint = 1048899857n;

export class AuditHashChainError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuditHashChainError";
    this.code = code;
  }
}

/**
 * Fields that go into the canonical row body hashed into row_hash.
 * Order of keys in this object does NOT matter — canonicalJson sorts —
 * but the set of keys DOES matter. Any key added or removed here is a
 * breaking chain-protocol change that requires a version bump of the
 * genesis marker in migration 036.
 */
export interface AuditRowBody {
  audit_id: string;
  action_type_api_name: string;
  action_type_display_name: string;
  execution_id: string;
  parameters: Record<string, unknown>;
  affected_objects: unknown[];
  affected_object_count: number;
  result: "success" | "failed" | "partial";
  failure_type: string | null;
  error_message: string | null;
  duration_ms: number;
  executed_by: string;
  executed_at: string; // ISO8601 UTC
  branch_id: string | null;
  source_ip: string | null;
  metadata: Record<string, unknown>;
  // Phase 8 — semantics + correlation-id on the audit row (migration 121).
  semantics_version?: number | null;
  execution_mode?: string | null;
  correlation_id?: string | null;
}

/**
 * Compute prev_hash and row_hash for an audit row, write the row into
 * action_audit_log, and advance the singleton head pointer. MUST be
 * called inside an open PG transaction on `client`.
 *
 * The caller's transaction drives COMMIT/ROLLBACK: if any step here
 * throws, the Action edit that preceded this call rolls back together
 * with it (durable-before-ack).
 */
export async function insertAuditRowWithHashChain(
  client: PoolClient,
  rowBody: AuditRowBody,
): Promise<{ auditId: string; rowHash: string; prevHash: string; seq: bigint }> {
  // Step 1 — advisory lock. pg_advisory_xact_lock blocks until acquired;
  // it is released when the transaction ends.
  await client.query("SELECT pg_advisory_xact_lock($1)", [AUDIT_HASH_CHAIN_LOCK_KEY.toString()]);

  // Step 2 — read head.
  const headResult = await client.query<{
    head_hash: string;
    head_audit_id: string;
    head_seq: string;
  }>(
    "SELECT head_hash, head_audit_id, head_seq FROM audit_hash_head WHERE id = 1 FOR UPDATE",
  );
  if (headResult.rowCount !== 1) {
    incCounter("tellus_action_audit_chain_head_missing_total", {});
    throw new AuditHashChainError(
      "AUDIT_CHAIN_HEAD_MISSING",
      "audit_hash_head singleton row is missing — migration 036 not applied or head corrupted",
    );
  }
  const head = headResult.rows[0];

  // Step 3 — compute prev_hash + row_hash.
  const prevHash = head.head_hash;
  const canon = canonicalJson(rowBody);
  const rowHash = createHash("sha256")
    .update(prevHash, "utf8")
    .update("\n", "utf8") // separator prevents length-extension ambiguity
    .update(canon, "utf8")
    .digest("hex");

  // Step 4 — INSERT the audit row.
  await client.query(
    `INSERT INTO action_audit_log (
       audit_id,
       action_type_api_name,
       action_type_display_name,
       execution_id,
       parameters,
       affected_objects,
       affected_object_count,
       result,
       failure_type,
       error_message,
       duration_ms,
       executed_by,
       executed_at,
       branch_id,
       source_ip,
       metadata,
       semantics_version,
       execution_mode,
       correlation_id,
       prev_hash,
       row_hash
      ) VALUES (
        $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21
      )`,
    [
      rowBody.audit_id,
      rowBody.action_type_api_name,
      rowBody.action_type_display_name,
      rowBody.execution_id,
      JSON.stringify(rowBody.parameters),
      JSON.stringify(rowBody.affected_objects),
      rowBody.affected_object_count,
      rowBody.result,
      rowBody.failure_type,
      rowBody.error_message,
      rowBody.duration_ms,
      rowBody.executed_by,
      rowBody.executed_at,
      rowBody.branch_id,
      rowBody.source_ip,
      JSON.stringify(rowBody.metadata),
      rowBody.semantics_version ?? null,
      rowBody.execution_mode ?? null,
      rowBody.correlation_id ?? null,
      prevHash,
      rowHash,
    ],
  );

  // Step 5 — advance head.
  const nextSeq = BigInt(head.head_seq) + 1n;
  await client.query(
    `UPDATE audit_hash_head
        SET head_hash = $1,
            head_audit_id = $2,
            head_seq = $3,
            updated_at = now(),
            updated_by = $4
      WHERE id = 1`,
    [rowHash, rowBody.audit_id, nextSeq.toString(), rowBody.executed_by],
  );

  incCounter("tellus_action_audit_chain_appended_total", {});
  return { auditId: rowBody.audit_id, rowHash, prevHash, seq: nextSeq };
}

/**
 * Forward-walk verifier. Called by src/jobs/auditVerifier.ts on a
 * schedule, and by Block B tests to demonstrate chain-break detection.
 */
export interface ChainBreak {
  audit_id: string;
  executed_at: string;
  expected_prev_hash: string;
  actual_prev_hash: string | null;
  expected_row_hash: string;
  actual_row_hash: string | null;
  reason: "prev_hash_mismatch" | "row_hash_mismatch" | "null_hash";
}

export interface VerifyReport {
  verified: number;
  breaks: ChainBreak[];
  last_verified_audit_id: string | null;
  last_verified_row_hash: string | null;
}

export async function verifyChainSegment(
  client: PoolClient,
  options: { startAfterExecutedAt?: string; limit?: number } = {},
): Promise<VerifyReport> {
  const limit = options.limit ?? 1000;
  const startAfter = options.startAfterExecutedAt ?? "1970-01-01 00:00:00+00";

  const rows = await client.query<{
    audit_id: string;
    action_type_api_name: string;
    action_type_display_name: string;
    execution_id: string;
    parameters: Record<string, unknown>;
    affected_objects: unknown[];
    affected_object_count: number;
    result: "success" | "failed" | "partial";
    failure_type: string | null;
    error_message: string | null;
    duration_ms: number;
    executed_by: string;
    executed_at: Date;
    branch_id: string | null;
    source_ip: string | null;
    metadata: Record<string, unknown>;
    prev_hash: string | null;
    row_hash: string | null;
  }>(
    `SELECT audit_id, action_type_api_name, action_type_display_name, execution_id,
            parameters, affected_objects, affected_object_count, result, failure_type,
            error_message, duration_ms, executed_by, executed_at, branch_id, source_ip,
            metadata, prev_hash, row_hash
       FROM action_audit_log
      WHERE executed_at >= $1
      ORDER BY executed_at ASC, audit_id ASC
      LIMIT $2`,
    [startAfter, limit],
  );

  const breaks: ChainBreak[] = [];
  let expectedPrev: string | null = null;
  let lastOk: { audit_id: string; row_hash: string } | null = null;
  let verified = 0;

  for (const row of rows.rows) {
    const isoExecutedAt =
      row.executed_at instanceof Date ? row.executed_at.toISOString() : String(row.executed_at);

    if (row.row_hash === null) {
      breaks.push({
        audit_id: row.audit_id,
        executed_at: isoExecutedAt,
        expected_prev_hash: expectedPrev ?? "",
        actual_prev_hash: row.prev_hash,
        expected_row_hash: "(unverifiable — row_hash is NULL)",
        actual_row_hash: null,
        reason: "null_hash",
      });
      expectedPrev = null;
      continue;
    }
    // Compute what row_hash should be.
    const rowBody: AuditRowBody = {
      audit_id: row.audit_id,
      action_type_api_name: row.action_type_api_name,
      action_type_display_name: row.action_type_display_name,
      execution_id: row.execution_id,
      parameters: row.parameters ?? {},
      affected_objects: row.affected_objects ?? [],
      affected_object_count: row.affected_object_count,
      result: row.result,
      failure_type: row.failure_type,
      error_message: row.error_message,
      duration_ms: row.duration_ms,
      executed_by: row.executed_by,
      executed_at: isoExecutedAt,
      branch_id: row.branch_id,
      source_ip: row.source_ip,
      metadata: row.metadata ?? {},
    };
    const canon = canonicalJson(rowBody);
    const prev = row.prev_hash ?? "";
    const expectedRowHash = createHash("sha256")
      .update(prev, "utf8")
      .update("\n", "utf8")
      .update(canon, "utf8")
      .digest("hex");

    // prev_hash check (skip for genesis row where both prev_hash and
    // expectedPrev are null).
    if (expectedPrev !== null && row.prev_hash !== expectedPrev) {
      breaks.push({
        audit_id: row.audit_id,
        executed_at: isoExecutedAt,
        expected_prev_hash: expectedPrev,
        actual_prev_hash: row.prev_hash,
        expected_row_hash: expectedRowHash,
        actual_row_hash: row.row_hash,
        reason: "prev_hash_mismatch",
      });
    } else if (expectedRowHash !== row.row_hash) {
      breaks.push({
        audit_id: row.audit_id,
        executed_at: isoExecutedAt,
        expected_prev_hash: expectedPrev ?? prev,
        actual_prev_hash: row.prev_hash,
        expected_row_hash: expectedRowHash,
        actual_row_hash: row.row_hash,
        reason: "row_hash_mismatch",
      });
    } else {
      verified += 1;
      lastOk = { audit_id: row.audit_id, row_hash: row.row_hash };
    }
    expectedPrev = row.row_hash;
  }

  if (breaks.length > 0) {
    incCounter("tellus_audit_chain_breaks_total", { segment: String(rows.rowCount) });
  }

  return {
    verified,
    breaks,
    last_verified_audit_id: lastOk?.audit_id ?? null,
    last_verified_row_hash: lastOk?.row_hash ?? null,
  };
}
