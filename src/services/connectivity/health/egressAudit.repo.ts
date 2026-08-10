// ---------------------------------------------------------------------------
// F7 — connectivity_egress_audit_log repo.
//
// Append-only audit trail for every DIRECT backend egress (webhook execution,
// health probe, worker fetch) that bypasses any agent-based network isolation.
// See migration 160. Never stores plaintext or request/response bodies — only
// the destination host:port, connection RID, and outcome.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";

export type EgressAuditSource =
  | "webhook"
  | "health-probe"
  | "worker-fetch"
  | "pg-connect";

export interface EgressAuditRow {
  connectionRid: string;
  tenant: string;
  source: EgressAuditSource;
  egressMode: "direct" | "agent-tunnel";
  destinationHost: string;
  destinationPort: number;
  webhookRid?: string | null;
  outcome: "success" | "failure";
  reason?: string;
  actor?: string | null;
  requestId?: string | null;
  agentRid?: string | null;
}

export async function recordEgressAudit(row: EgressAuditRow): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO connectivity_egress_audit_log
       (connection_rid, tenant, source, egress_mode,
        destination_host, destination_port, webhook_rid,
        outcome, reason, actor, request_id, agent_rid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      row.connectionRid,
      row.tenant,
      row.source,
      row.egressMode,
      row.destinationHost,
      row.destinationPort,
      row.webhookRid ?? null,
      row.outcome,
      row.reason ?? null,
      row.actor ?? null,
      row.requestId ?? null,
      row.agentRid ?? null,
    ],
  );
  return result.rows[0].id;
}
