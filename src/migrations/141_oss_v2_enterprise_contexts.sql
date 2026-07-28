-- OSS/OSv2 enterprise read contexts and durable subscriptions.
-- Rollout order: schema -> application readers -> application writers.

CREATE TABLE IF NOT EXISTS ontology_read_context (
  context_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rid               TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('transaction', 'scenario')),
  tenant_id         TEXT NOT NULL,
  ontology_id       UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id         TEXT,
  owner_user_id     TEXT NOT NULL,
  allowed_user_ids  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'committed', 'expired', 'deleted')),
  base_revision     TEXT,
  version           BIGINT NOT NULL DEFAULT 1,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ontology_read_context_scope
  ON ontology_read_context (tenant_id, ontology_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_ontology_read_context_expiry
  ON ontology_read_context (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'open';

CREATE TABLE IF NOT EXISTS ontology_read_context_object_edit (
  edit_sequence      BIGSERIAL PRIMARY KEY,
  context_id         UUID NOT NULL REFERENCES ontology_read_context(context_id) ON DELETE CASCADE,
  context_version    BIGINT NOT NULL,
  object_type_api_name TEXT NOT NULL,
  primary_key        TEXT NOT NULL,
  object_rid         TEXT,
  operation          TEXT NOT NULL CHECK (operation IN ('create', 'modify', 'delete')),
  properties         JSONB NOT NULL DEFAULT '{}'::JSONB,
  changed_properties TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  base_properties    JSONB,
  base_markings      TEXT[],
  base_object_version BIGINT,
  base_object_rid    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Populated-upgrade compatibility: an early preview of this migration
-- created the edit tables before context-version pinning was added.
ALTER TABLE ontology_read_context_object_edit
  ADD COLUMN IF NOT EXISTS context_version BIGINT;
ALTER TABLE ontology_read_context_object_edit
  ADD COLUMN IF NOT EXISTS base_properties JSONB,
  ADD COLUMN IF NOT EXISTS base_markings TEXT[],
  ADD COLUMN IF NOT EXISTS base_object_version BIGINT,
  ADD COLUMN IF NOT EXISTS base_object_rid TEXT;
UPDATE ontology_read_context_object_edit edit
   SET context_version = context.version
  FROM ontology_read_context context
 WHERE edit.context_id = context.context_id
   AND edit.context_version IS NULL;
ALTER TABLE ontology_read_context_object_edit
  ALTER COLUMN context_version SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_read_context_object_latest
  ON ontology_read_context_object_edit
  (context_id, object_type_api_name, primary_key, edit_sequence DESC);

CREATE TABLE IF NOT EXISTS ontology_read_context_link_edit (
  edit_sequence       BIGSERIAL PRIMARY KEY,
  context_id          UUID NOT NULL REFERENCES ontology_read_context(context_id) ON DELETE CASCADE,
  context_version     BIGINT NOT NULL,
  link_type_api_name  TEXT NOT NULL,
  source_object_type  TEXT NOT NULL,
  source_primary_key  TEXT NOT NULL,
  target_object_type  TEXT NOT NULL,
  target_primary_key  TEXT NOT NULL,
  operation           TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ontology_read_context_link_edit
  ADD COLUMN IF NOT EXISTS context_version BIGINT;
UPDATE ontology_read_context_link_edit edit
   SET context_version = context.version
  FROM ontology_read_context context
 WHERE edit.context_id = context.context_id
   AND edit.context_version IS NULL;
ALTER TABLE ontology_read_context_link_edit
  ALTER COLUMN context_version SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_read_context_link_latest
  ON ontology_read_context_link_edit
  (context_id, link_type_api_name, source_primary_key, target_primary_key,
   edit_sequence DESC);

-- Optional ontology metadata used by documented PropertyLoadLevel behavior.
ALTER TABLE property
  ADD COLUMN IF NOT EXISTS reducer_config JSONB,
  ADD COLUMN IF NOT EXISTS struct_main_value_field TEXT;

CREATE TABLE IF NOT EXISTS object_set_event (
  event_sequence      BIGSERIAL PRIMARY KEY,
  event_id            UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  deduplication_key   TEXT NOT NULL UNIQUE,
  tenant_id           TEXT NOT NULL,
  ontology_id         UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id           TEXT,
  transaction_id      TEXT,
  scenario_rid        TEXT,
  object_type_api_name TEXT NOT NULL,
  primary_key         TEXT NOT NULL,
  object_rid          TEXT,
  state               TEXT NOT NULL CHECK (state IN ('ADDED_OR_UPDATED', 'REMOVED')),
  object_value        JSONB,
  changed_properties  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  changed_link_types  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE object_set_event
  ADD COLUMN IF NOT EXISTS deduplication_key TEXT;
UPDATE object_set_event
   SET deduplication_key = 'legacy:' || event_id::text
 WHERE deduplication_key IS NULL;
ALTER TABLE object_set_event
  ALTER COLUMN deduplication_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_object_set_event_deduplication
  ON object_set_event (deduplication_key);

CREATE INDEX IF NOT EXISTS idx_object_set_event_scope_cursor
  ON object_set_event (tenant_id, ontology_id, event_sequence);
CREATE INDEX IF NOT EXISTS idx_object_set_event_dependencies
  ON object_set_event (ontology_id, object_type_api_name, event_sequence);
CREATE INDEX IF NOT EXISTS idx_object_set_event_occurred
  ON object_set_event (occurred_at);

CREATE TABLE IF NOT EXISTS object_set_subscription (
  subscription_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL,
  ontology_id         UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  owner_user_id       TEXT NOT NULL,
  branch_id           TEXT,
  transaction_id      TEXT,
  scenario_rid        TEXT,
  object_set           JSONB NOT NULL,
  fingerprint          TEXT NOT NULL,
  property_set         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reference_set        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dependency_types     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dependency_properties TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'closed')),
  last_acknowledged_sequence BIGINT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_object_set_subscription_owner
  ON object_set_subscription (tenant_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_object_set_subscription_dependencies
  ON object_set_subscription USING GIN (dependency_types);

CREATE TABLE IF NOT EXISTS oss_v2_audit_event (
  audit_id             BIGSERIAL PRIMARY KEY,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type           TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  ontology_id          UUID,
  user_id              TEXT NOT NULL,
  branch_id            TEXT,
  transaction_id       TEXT,
  scenario_rid         TEXT,
  request_id           TEXT,
  outcome              TEXT NOT NULL,
  parameters           JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_oss_v2_audit_scope
  ON oss_v2_audit_event (tenant_id, ontology_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS ontology_embedding_config (
  tenant_id            TEXT NOT NULL,
  ontology_id          UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  object_type_api_name TEXT NOT NULL,
  property_api_name    TEXT NOT NULL,
  provider             TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  dimensions           INTEGER NOT NULL CHECK (dimensions > 0),
  endpoint              TEXT,
  credential_env        TEXT,
  timeout_ms            INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 100 AND 60000),
  max_retries           INTEGER NOT NULL DEFAULT 2 CHECK (max_retries BETWEEN 0 AND 5),
  requests_per_second   INTEGER NOT NULL DEFAULT 20 CHECK (requests_per_second > 0),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, ontology_id, object_type_api_name, property_api_name)
);
