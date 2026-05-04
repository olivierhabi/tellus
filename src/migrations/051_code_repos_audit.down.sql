-- Reverses migration 032. Drop order respects FK dependency:
--   code_repos_idempotency.audit_id → code_repos_audit_events.audit_id
DROP INDEX IF EXISTS code_repos_idempotency_expires_at_idx;
DROP TABLE IF EXISTS code_repos_idempotency;

DROP TABLE IF EXISTS code_repos_audit_hash_head;

DROP INDEX IF EXISTS code_repos_audit_request_id_idx;
DROP INDEX IF EXISTS code_repos_audit_seq_idx;
DROP INDEX IF EXISTS code_repos_audit_principal_idx;
DROP INDEX IF EXISTS code_repos_audit_target_rid_idx;
DROP TABLE IF EXISTS code_repos_audit_events;
