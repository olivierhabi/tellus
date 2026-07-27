-- Reverse of 129_webhook_definition.sql

DROP TABLE IF EXISTS webhook_secret_reference;

DROP INDEX IF EXISTS idx_webhook_definition_ontology_status;
DROP INDEX IF EXISTS idx_webhook_definition_lookup;
DROP INDEX IF EXISTS uq_webhook_definition_live_name;

DROP TABLE IF EXISTS webhook_definition;
