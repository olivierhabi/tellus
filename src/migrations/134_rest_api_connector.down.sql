DELETE FROM connector_types WHERE id = 'rest-api';

ALTER TABLE connectivity_connections
  DROP CONSTRAINT IF EXISTS connectivity_connections_connector_type_check;

ALTER TABLE connectivity_connections
  ADD CONSTRAINT connectivity_connections_connector_type_check
  CHECK (connector_type IN ('postgresql'));
