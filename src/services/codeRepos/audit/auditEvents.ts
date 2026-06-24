// ---------------------------------------------------------------------------
// Code Repositories — audit chain writer.
//
// Spec contracts:
//   G-C-51   Every mutating endpoint writes exactly one audit row
//   G-C-52   Audit row is durable before HTTP 2xx is acknowledged
//   G-C-53   Audit row carries before_hash + after_hash on mutations
//   G-C-54   Audit chain is tamper-evident (sha256(prev_hash || canon))
//   §1.10    7-year retention; SUCCESS-only; advisory-lock for ordering
//
// Pattern parallels src/services/audit/hashChain.ts but uses an isolated
// chain table (code_repos_audit_events) and an isolated advisory-lock
// key. The two chains never interfere; a defect in one cannot corrupt
// the other.
//
// Lock key derivation:
//   SELECT hashtext('tellus.code_repos.audit.hash_head');  -- → 2059623761
// Pinned by tests/unit/code-repos/audit/lock-key-unit.test.ts.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../audit/canonicalJson";
import {
  recordAuditChainAppended,
  recordAuditChainHeadMissing,
} from "../observability/metrics";

/**
 * Advisory-lock key for serializing concurrent writers on
 * code_repos_audit_hash_head. Distinct from the Actions chain key
 * (1048899857) so the two chains never block each other.
 *
 * Derivation: hashtext('tellus.code_repos.audit.hash_head') → 2059623761.
 * The Postgres equivalent for verification is:
 *   SELECT hashtext('tellus.code_repos.audit.hash_head');
 */
export const CODE_REPOS_AUDIT_LOCK_KEY: bigint = 2059623761n;

/**
 * Genesis row hash — sha256("tellus-code-repos-audit-genesis-v1").
 * Pinned by tests/unit/code-repos/audit/genesis-hash-unit.test.ts so a
 * change here also requires bumping migration 032's seed.
 */
export const GENESIS_HASH =
  "f5231d667c23085fdcfc58be156f84a21ef7de2cdeefc4e5f23011ad81a8efb8";

export class CodeReposAuditError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodeReposAuditError";
    this.code = code;
  }
}

/**
 * Shape of an audit event body. The DB schema enforces stricter validity
 * (regex on category, action, RID, hashes) but TS-level structural typing
 * catches most field-omission bugs at compile time.
 */
export interface CodeReposAuditEvent {
  readonly category: string;
  readonly action: string;
  readonly targetRid: string;
  readonly targetType: string;
  readonly principalUserId: string;
  readonly principalSource: "cookie" | "bearer-jwt" | "pat" | "system";
  readonly requestId: string;
  /** sha256 of canonical_json(beforeState). Null on create. */
  readonly beforeHash: string | null;
  /** sha256 of canonical_json(afterState). Null on delete. */
  readonly afterHash: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly parameters: Record<string, unknown>;
}

export interface InsertedAuditEvent {
  readonly auditId: string;
  readonly seq: bigint;
  readonly rowHash: string;
  readonly prevHash: string;
}

/**
 * Inserts one row into code_repos_audit_events inside the caller's
 * transaction. The caller's tx drives COMMIT/ROLLBACK; if anything here
 * throws, the data edit rolls back with it (durable-before-ack §1.10).
 *
 * Steps (mirrors src/services/audit/hashChain.ts but on the parallel
 * code-repos chain):
 *   1. pg_advisory_xact_lock(CODE_REPOS_AUDIT_LOCK_KEY) — serializes
 *      writers on the head pointer.
 *   2. SELECT FOR UPDATE on code_repos_audit_hash_head WHERE id=1.
 *   3. row_hash = sha256(prev_hash || "\n" || canonical_json(event)).
 *   4. INSERT the audit row.
 *   5. UPDATE the head pointer to the new row.
 */
export async function insertCodeReposAuditEvent(
  client: PoolClient,
  event: CodeReposAuditEvent,
): Promise<InsertedAuditEvent> {
  // Step 1 — advisory lock (released at tx end).
  await client.query("SELECT pg_advisory_xact_lock($1)", [
    CODE_REPOS_AUDIT_LOCK_KEY.toString(),
  ]);

  // Step 2 — read head with row lock.
  const headResult = await client.query<{
    head_hash: string;
    head_audit_id: string;
    head_seq: string;
  }>(
    "SELECT head_hash, head_audit_id, head_seq FROM code_repos_audit_hash_head WHERE id = 1 FOR UPDATE",
  );
  if (headResult.rowCount !== 1) {
    // G-C-54 telemetry hook — page-on counter. Record BEFORE throwing so
    // the metric is incremented even if the caller's tx aborts. The
    // counter lives in the metrics shim's in-process state, not in PG,
    // so it survives the rollback.
    recordAuditChainHeadMissing();
    throw new CodeReposAuditError(
      "AUDIT_CHAIN_HEAD_MISSING",
      "code_repos_audit_hash_head singleton row is missing — migration 032 not applied",
    );
  }
  const head = headResult.rows[0];
  const prevHash = head.head_hash;

  // Step 3 — compute row_hash. Canonical input excludes the chain
  // metadata so the hash covers only the event content.
  const canonInput: Record<string, unknown> = {
    category: event.category,
    action: event.action,
    target_rid: event.targetRid,
    target_type: event.targetType,
    principal_user_id: event.principalUserId,
    principal_source: event.principalSource,
    request_id: event.requestId,
    before_hash: event.beforeHash,
    after_hash: event.afterHash,
    source_ip: event.sourceIp,
    user_agent: event.userAgent,
    parameters: event.parameters,
  };
  const canon = canonicalJson(canonInput);
  const rowHash = createHash("sha256")
    .update(prevHash, "utf8")
    .update("\n", "utf8") // separator prevents length-extension ambiguity
    .update(canon, "utf8")
    .digest("hex");

  // Step 4 — INSERT the row. seq comes from the BIGSERIAL; we read it
  // back to advance the head.
  const insertResult = await client.query<{ audit_id: string; seq: string }>(
    `INSERT INTO code_repos_audit_events (
       category, action, target_rid, target_type,
       principal_user_id, principal_source, result, request_id,
       before_hash, after_hash, source_ip, user_agent,
       parameters, prev_hash, row_hash
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, 'SUCCESS', $7,
       $8, $9, $10, $11,
       $12::jsonb, $13, $14
     ) RETURNING audit_id, seq`,
    [
      event.category,
      event.action,
      event.targetRid,
      event.targetType,
      event.principalUserId,
      event.principalSource,
      event.requestId,
      event.beforeHash,
      event.afterHash,
      event.sourceIp,
      event.userAgent,
      JSON.stringify(event.parameters),
      prevHash,
      rowHash,
    ],
  );
  const inserted = insertResult.rows[0];
  const newSeq = BigInt(inserted.seq);

  // Step 5 — advance head pointer.
  await client.query(
    `UPDATE code_repos_audit_hash_head
       SET head_hash = $1, head_audit_id = $2, head_seq = $3, updated_at = now()
     WHERE id = 1`,
    [rowHash, inserted.audit_id, newSeq.toString()],
  );

  // §1.8 healthy-path counter — paired with auditChainHeadMissingTotal so
  // dashboards can compute the missing-rate as a fraction of total appends.
  recordAuditChainAppended();

  return {
    auditId: inserted.audit_id,
    seq: newSeq,
    rowHash,
    prevHash,
  };
}

/**
 * Compute sha256(canonical_json(state)) for a resource snapshot. Used by
 * callers to populate beforeHash / afterHash on mutations.
 */
export function hashResourceState(state: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

/**
 * Forward-walk verifier — recomputes row_hash for every row from
 * `startAfterSeq + 1` up to `startAfterSeq + limit`, asserting
 * (a) prev_hash matches the previous row's row_hash and
 * (b) row_hash matches sha256(prev_hash || canon(event)).
 *
 * Returns the first break encountered (if any). Used by the daily
 * audit verifier cron and by tests/integration/code-repos/audit
 * tamper-evidence tests.
 */
export interface ChainBreak {
  readonly seq: bigint;
  readonly auditId: string;
  readonly reason: "PREV_HASH_MISMATCH" | "ROW_HASH_MISMATCH";
  readonly expected: string;
  readonly actual: string;
}

export async function verifyChainSegment(
  client: PoolClient,
  startAfterSeq: bigint,
  limit: number,
): Promise<{ checked: number; break: ChainBreak | null }> {
  const rows = await client.query<{
    seq: string;
    audit_id: string;
    category: string;
    action: string;
    target_rid: string;
    target_type: string;
    principal_user_id: string;
    principal_source: string;
    request_id: string;
    before_hash: string | null;
    after_hash: string | null;
    source_ip: string | null;
    user_agent: string | null;
    parameters: Record<string, unknown>;
    prev_hash: string;
    row_hash: string;
  }>(
    `SELECT seq, audit_id, category, action, target_rid, target_type,
            principal_user_id, principal_source, request_id,
            before_hash, after_hash, source_ip, user_agent,
            parameters, prev_hash, row_hash
       FROM code_repos_audit_events
      WHERE seq > $1
      ORDER BY seq ASC
      LIMIT $2`,
    [startAfterSeq.toString(), limit],
  );

  // Anchor — fetch the row at startAfterSeq so we can compare prev_hash
  // of the first walked row to the anchor's row_hash.
  let prevRowHash: string;
  if (startAfterSeq === 0n) {
    prevRowHash = GENESIS_HASH;
  } else {
    const anchor = await client.query<{ row_hash: string }>(
      "SELECT row_hash FROM code_repos_audit_events WHERE seq = $1",
      [startAfterSeq.toString()],
    );
    if (anchor.rowCount !== 1) {
      throw new CodeReposAuditError(
        "ANCHOR_MISSING",
        `verifyChainSegment: anchor seq=${startAfterSeq} not found`,
      );
    }
    prevRowHash = anchor.rows[0].row_hash;
  }

  let checked = 0;
  for (const r of rows.rows) {
    checked += 1;
    if (r.prev_hash !== prevRowHash) {
      return {
        checked,
        break: {
          seq: BigInt(r.seq),
          auditId: r.audit_id,
          reason: "PREV_HASH_MISMATCH",
          expected: prevRowHash,
          actual: r.prev_hash,
        },
      };
    }
    const canonInput: Record<string, unknown> = {
      category: r.category,
      action: r.action,
      target_rid: r.target_rid,
      target_type: r.target_type,
      principal_user_id: r.principal_user_id,
      principal_source: r.principal_source,
      request_id: r.request_id,
      before_hash: r.before_hash,
      after_hash: r.after_hash,
      source_ip: r.source_ip,
      user_agent: r.user_agent,
      parameters: r.parameters,
    };
    const canon = canonicalJson(canonInput);
    const recomputed = createHash("sha256")
      .update(r.prev_hash, "utf8")
      .update("\n", "utf8")
      .update(canon, "utf8")
      .digest("hex");
    if (recomputed !== r.row_hash) {
      return {
        checked,
        break: {
          seq: BigInt(r.seq),
          auditId: r.audit_id,
          reason: "ROW_HASH_MISMATCH",
          expected: recomputed,
          actual: r.row_hash,
        },
      };
    }
    prevRowHash = r.row_hash;
  }

  return { checked, break: null };
}
