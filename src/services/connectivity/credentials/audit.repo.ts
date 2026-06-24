// ---------------------------------------------------------------------------
// connectivity_credentials_audit repo (B2).
// Append-only. Every credential op writes exactly one row (success OR failure).
// Used by the §116.1 plaintext-scan regression — this table MUST NEVER hold
// raw ciphertext or plaintext; only structured metadata.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";

export type CredentialOperation =
  | "create"
  | "rotate"
  | "supersede"
  | "read"
  | "unwrap"
  | "delete";

export interface AuditWrite {
  connectionRid: string;
  tenant: string;
  field: string;
  version: number;
  operation: CredentialOperation;
  actor: string;
  outcome: "success" | "failure";
  reason?: string;
  requestId?: string;
  clientIp?: string;
  scopes?: string[];
}

export async function write(row: AuditWrite): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO connectivity_credentials_audit
       (connection_rid, tenant, field, version, operation, actor,
        outcome, reason, scopes, client_ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::inet, $11)
     RETURNING id`,
    [
      row.connectionRid,
      row.tenant,
      row.field,
      row.version,
      row.operation,
      row.actor,
      row.outcome,
      row.reason ?? null,
      row.scopes ?? null,
      row.clientIp ?? null,
      row.requestId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function listForConnection(
  connectionRid: string,
  tenant: string,
  pageSize: number = 100,
): Promise<Array<{
  occurredAt: Date;
  operation: string;
  outcome: string;
  actor: string;
  field: string;
  version: number;
  reason: string | null;
}>> {
  const result = await pool.query<{
    occurred_at: Date;
    operation: string;
    outcome: string;
    actor: string;
    field: string;
    version: number;
    reason: string | null;
  }>(
    `SELECT occurred_at, operation, outcome, actor, field, version, reason
       FROM connectivity_credentials_audit
      WHERE connection_rid = $1 AND tenant = $2
      ORDER BY occurred_at DESC
      LIMIT $3`,
    [connectionRid, tenant, Math.min(Math.max(pageSize, 1), 1000)],
  );
  return result.rows.map((r) => ({
    occurredAt: r.occurred_at,
    operation: r.operation,
    outcome: r.outcome,
    actor: r.actor,
    field: r.field,
    version: r.version,
    reason: r.reason,
  }));
}

/** §116.1 plaintext-scan regression hook — returns true if any audit row body contains the needle. */
export async function scanForPlaintext(needle: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM connectivity_credentials_audit
       WHERE reason ILIKE '%' || $1 || '%'
     ) AS found`,
    [needle],
  );
  return result.rows[0]?.found ?? false;
}
