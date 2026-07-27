-- Source-scoped, versioned webhook definitions and delivery history.
-- Configuration versions are immutable; the identity row owns lifecycle state.
-- Secret values are never stored here: request templates reference source-vault
-- names and are resolved only inside the server-side executor.

CREATE TABLE IF NOT EXISTS connectivity_webhook (
  rid                  TEXT PRIMARY KEY
                       CHECK (rid ~ '^ri\.magritte\.main\.webhook\.[0-9a-f-]{36}$'),
  tenant               TEXT NOT NULL,
  connection_rid       TEXT NOT NULL REFERENCES connectivity_connections(rid) ON DELETE CASCADE,
  api_name              TEXT NOT NULL CHECK (api_name ~ '^[A-Z][A-Za-z0-9]{0,99}$'),
  display_name          TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
  description           TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  status                TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','validating','ready','active','disabled','failed','archived')),
  current_version       INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            TEXT NOT NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            TEXT NOT NULL,
  archived_at           TIMESTAMPTZ,
  UNIQUE (tenant, connection_rid, api_name)
);

CREATE INDEX IF NOT EXISTS idx_connectivity_webhook_source
  ON connectivity_webhook(tenant, connection_rid, status, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS connectivity_webhook_version (
  webhook_rid           TEXT NOT NULL REFERENCES connectivity_webhook(rid) ON DELETE CASCADE,
  version               INTEGER NOT NULL CHECK (version >= 1),
  request_config        JSONB NOT NULL,
  input_parameters      JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_parameters     JSONB NOT NULL DEFAULT '[]'::jsonb,
  storage_config        JSONB NOT NULL,
  execution_policy      JSONB NOT NULL,
  trigger_config        JSONB NOT NULL DEFAULT '{"kind":"manual"}'::jsonb,
  signature_config      JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            TEXT NOT NULL,
  PRIMARY KEY (webhook_rid, version),
  CHECK (jsonb_typeof(request_config) = 'object'),
  CHECK (jsonb_typeof(input_parameters) = 'array'),
  CHECK (jsonb_typeof(output_parameters) = 'array'),
  CHECK (jsonb_typeof(storage_config) = 'object'),
  CHECK (jsonb_typeof(execution_policy) = 'object'),
  CHECK (jsonb_typeof(trigger_config) = 'object'),
  CHECK (signature_config IS NULL OR jsonb_typeof(signature_config) = 'object')
);

CREATE TABLE IF NOT EXISTS connectivity_webhook_execution (
  rid                    TEXT PRIMARY KEY
                         CHECK (rid ~ '^ri\.magritte\.main\.webhook-execution\.[0-9a-f-]{36}$'),
  tenant                 TEXT NOT NULL,
  webhook_rid            TEXT NOT NULL REFERENCES connectivity_webhook(rid) ON DELETE CASCADE,
  webhook_version        INTEGER NOT NULL,
  kind                   TEXT NOT NULL CHECK (kind IN ('test','production')),
  status                 TEXT NOT NULL
                         CHECK (status IN ('queued','running','succeeded','failed','cancelled','dead_lettered')),
  correlation_id         UUID NOT NULL,
  idempotency_key_hash   TEXT NOT NULL,
  triggered_by           TEXT NOT NULL,
  input_summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary         JSONB,
  error_code             TEXT,
  error_message          TEXT,
  http_status            INTEGER,
  duration_ms            INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  external_system_changed BOOLEAN,
  started_at             TIMESTAMPTZ,
  completed_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant, webhook_rid, idempotency_key_hash),
  FOREIGN KEY (webhook_rid, webhook_version)
    REFERENCES connectivity_webhook_version(webhook_rid, version)
);

CREATE INDEX IF NOT EXISTS idx_connectivity_webhook_execution_history
  ON connectivity_webhook_execution(tenant, webhook_rid, created_at DESC);

CREATE TABLE IF NOT EXISTS connectivity_webhook_delivery_attempt (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_rid          TEXT NOT NULL REFERENCES connectivity_webhook_execution(rid) ON DELETE CASCADE,
  attempt_number         INTEGER NOT NULL CHECK (attempt_number >= 1),
  status                 TEXT NOT NULL CHECK (status IN ('running','succeeded','retryable_failure','terminal_failure','cancelled')),
  request_method         TEXT NOT NULL CHECK (request_method IN ('GET','POST','PUT','PATCH','DELETE')),
  request_url_redacted   TEXT NOT NULL,
  request_headers_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_headers_redacted JSONB,
  http_status            INTEGER,
  response_preview       TEXT,
  response_bytes         INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  error_code             TEXT,
  error_message          TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,
  next_attempt_at        TIMESTAMPTZ,
  UNIQUE (execution_rid, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_connectivity_webhook_attempt_execution
  ON connectivity_webhook_delivery_attempt(execution_rid, attempt_number);

COMMENT ON TABLE connectivity_webhook IS
  'Source-owned webhook identity and lifecycle. Permissions and tenant isolation derive from the associated connectivity source.';
COMMENT ON TABLE connectivity_webhook_version IS
  'Immutable, strongly validated webhook configuration versions. Secrets are references to the owning source vault, never plaintext.';
COMMENT ON TABLE connectivity_webhook_execution IS
  'Webhook execution history. Sensitive inputs/outputs are minimized and redacted according to the version storage policy.';
COMMENT ON TABLE connectivity_webhook_delivery_attempt IS
  'Bounded delivery-attempt history with retry classification and redacted request/response diagnostics.';
