-- ---------------------------------------------------------------------------
-- Migration 121 — Action Semantics v2 Schema Expansion (Stage A)
--
-- Additive, nullable columns so existing action types and audit logs remain
-- fully backward compatible. Nothing is dropped. NULL is interpreted at read
-- time (Stage B code deployment) as:
--     semantics_version = 1
--     execution_mode    = 'declarative'
--     delete_policy     = 'legacy_unchecked'
--
-- No CHECK constraints, NOT NULL, or foreign keys are added here. Those
-- land in Stage D (constraint validation) after Stage C backfill, in a
-- separate migration. This file only EXPANDS the schema.
-- ---------------------------------------------------------------------------

-- action_type: persisted semantics triple -----------------------------------
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS semantics_version SMALLINT;
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS execution_mode TEXT;
ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS delete_policy TEXT;

COMMENT ON COLUMN action_type.semantics_version IS
  'Action semantics version. NULL = version 1 (read-time fallback). 1 = legacy behaviour. 2 = typed references, restrict delete policy, same-invocation restrictions. Numeric and immutable; never "legacy" or "strict".';
COMMENT ON COLUMN action_type.execution_mode IS
  'How the rules execute. NULL = declarative. Only ''declarative'' is supported; ''function'' is rejected until function-rule execution is implemented.';
COMMENT ON COLUMN action_type.delete_policy IS
  'Referential-integrity policy for delete operations. NULL = legacy_unchecked. version 1 = legacy_unchecked (dangling links are warned, never blocking). version 2 = restrict (delete fails when active relationships remain). Future detach/cascade are not persisted yet.';

-- Index to find v2 action types (used by migration analysis & feature gating)
CREATE INDEX IF NOT EXISTS idx_action_type_semantics_version
  ON action_type(semantics_version)
  WHERE semantics_version IS NOT NULL;

-- action_audit_log: audit fields -------------------------------------------
ALTER TABLE action_audit_log
  ADD COLUMN IF NOT EXISTS semantics_version SMALLINT;
ALTER TABLE action_audit_log
  ADD COLUMN IF NOT EXISTS execution_mode TEXT;
ALTER TABLE action_audit_log
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

COMMENT ON COLUMN action_audit_log.semantics_version IS
  'Semantics version of the action type at execution time. NULL = version 1 (rows pre-dating the semantics migration).';
COMMENT ON COLUMN action_audit_log.execution_mode IS
  'Execution mode at execution time. NULL = declarative.';
COMMENT ON COLUMN action_audit_log.correlation_id IS
  'Correlation ID propagated through validation, planning, compilation, transaction, audit, Kafka, WebSocket, webhooks, and notifications for a single action invocation.';
