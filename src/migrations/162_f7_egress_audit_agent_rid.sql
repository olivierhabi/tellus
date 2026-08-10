-- F7 — add agent_rid column to connectivity_egress_audit_log.
--
-- When egressMode = 'agent-tunnel', this column records which agent handled
-- the egress. When egressMode = 'direct', it is NULL (the backend process
-- opened the socket directly). This makes the audit trail complete: every
-- egress row now records both the mode and the specific agent (if any).

ALTER TABLE connectivity_egress_audit_log
  ADD COLUMN IF NOT EXISTS agent_rid TEXT;
