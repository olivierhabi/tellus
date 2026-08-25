-- Adds REST API as a first-class Tellus connectivity source.
-- Configuration remains non-secret JSONB; additional secret values are
-- envelope-encrypted by the existing connectivity credential vault.

ALTER TABLE connectivity_connections
  DROP CONSTRAINT IF EXISTS connectivity_connections_connector_type_check;

ALTER TABLE connectivity_connections
  ADD CONSTRAINT connectivity_connections_connector_type_check
  CHECK (connector_type IN ('postgresql', 'rest-api'));

INSERT INTO connector_types (
  id,
  title,
  icon,
  icon_color,
  icon_src,
  tags,
  href,
  connector_type,
  capabilities,
  sort_order
)
VALUES (
  'rest-api',
  'REST API',
  'code',
  '#5C7080',
  NULL,
  ARRAY['Webhooks', 'Use in code'],
  '/data-connection/new-source/rest-api',
  'rest-api',
  '{"batchSync":false,"cdcSync":false,"tableExport":false,"useInCode":true}'::JSONB,
  20
)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  icon = EXCLUDED.icon,
  icon_color = EXCLUDED.icon_color,
  icon_src = EXCLUDED.icon_src,
  tags = EXCLUDED.tags,
  href = EXCLUDED.href,
  connector_type = EXCLUDED.connector_type,
  capabilities = EXCLUDED.capabilities,
  sort_order = EXCLUDED.sort_order,
  enabled = TRUE,
  updated_at = now();
