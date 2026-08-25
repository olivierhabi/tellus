-- F7 — connectivity_egress_audit_log
--
-- Append-only audit trail for every DIRECT backend egress (webhook execution,
-- health probe, worker fetch) that bypasses any agent-based network
-- isolation. The audit row records WHO triggered the egress (actor), to WHICH
-- destination (host:port), for WHICH connection / webhook, and the egressMode
-- in effect at the time. This makes the "backend direct egress" model
-- explicit and inspectable by operators + customers who assumed agent-tunneled
-- egress.
--
-- Never stores request/response bodies or secret material — only the
-- destination host:port, the connection RID, and the outcome.

CREATE TABLE IF NOT EXISTS connectivity_egress_audit_log (
  id                     BIGSERIAL PRIMARY KEY,
  connection_rid         TEXT NOT NULL,
  tenant                 TEXT NOT NULL,
  /* 'webhook' | 'health-probe' | 'worker-fetch' | 'pg-connect' */
  source                 TEXT NOT NULL,
  /* The connection-level egressMode in effect when the egress happened. */
  egress_mode            TEXT NOT NULL CHECK (egress_mode IN ('direct', 'agent-tunnel')),
  /* Resolved destination host + port. No path / query / fragment / headers. */
  destination_host       TEXT NOT NULL,
  destination_port      INTEGER NOT NULL,
  /* Optional webhook RID when source = 'webhook'. */
  webhook_rid            TEXT,
  /* 'success' | 'failure' */
  outcome                TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  /* Operator-visible reason (never carries plaintext). */
  reason                 TEXT,
  actor                  TEXT,
  request_id             TEXT,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connectivity_egress_audit_log_by_connection
  ON connectivity_egress_audit_log (connection_rid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS connectivity_egress_audit_log_by_tenant
  ON connectivity_egress_audit_log (tenant, occurred_at DESC);
