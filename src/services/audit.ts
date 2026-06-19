// ---------------------------------------------------------------------------
// audit.ts — append-only audit log writer (B5.01).
// Idempotent on event_id (UNIQUE constraint).
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

export interface AuditEvent {
  eventId?: string;
  actorId?: string | null;
  operationId: string;
  resourceRid?: string | null;
  decision: "ALLOW" | "DENY";
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditWriter {
  constructor(private readonly pool: Pool = defaultPool) {}

  /** Insert one event; idempotent on `eventId`. Returns the row's id. */
  async write(event: AuditEvent): Promise<string> {
    const eventId = event.eventId ?? randomUUID();
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO audit_log (event_id, actor_id, operation_id, resource_rid, decision, reason, request_id, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO UPDATE SET event_id = EXCLUDED.event_id
       RETURNING id`,
      [
        eventId,
        event.actorId ?? null,
        event.operationId,
        event.resourceRid ?? null,
        event.decision,
        event.reason ?? null,
        event.requestId ?? null,
        event.ip ?? null,
        event.metadata ?? {},
      ],
    );
    return rows[0].id;
  }
}

export const auditWriter = new AuditWriter();
