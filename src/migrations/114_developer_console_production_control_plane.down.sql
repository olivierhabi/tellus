DROP TABLE IF EXISTS tpa_audit_events;
DROP TABLE IF EXISTS tpa_reconciliation_jobs;
DROP TABLE IF EXISTS tpa_idempotency_keys;
DROP TABLE IF EXISTS tpa_application_members;

DROP INDEX IF EXISTS uq_tpa_tenant_creator_name_active;
DROP INDEX IF EXISTS idx_tpa_tenant_modified;

ALTER TABLE third_party_applications DROP COLUMN IF EXISTS identity_error;
ALTER TABLE third_party_applications DROP COLUMN IF EXISTS identity_state;
ALTER TABLE third_party_applications DROP COLUMN IF EXISTS row_version;
ALTER TABLE third_party_applications DROP COLUMN IF EXISTS tenant_id;
