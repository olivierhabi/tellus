-- F7 — drop agent_rid column from connectivity_egress_audit_log.

ALTER TABLE connectivity_egress_audit_log
  DROP COLUMN IF EXISTS agent_rid;
