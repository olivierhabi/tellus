-- Rollback: remove the Function publish authorization grant + audit tables.
DROP TABLE IF EXISTS function_publish_audit_log;
DROP TABLE IF EXISTS function_publish_grants;
