-- ---------------------------------------------------------------------------
-- Migration 129 — Governed Webhook Registry
--
-- Production writeback & side-effect webhooks MUST reference a governed,
-- versioned, registered webhook definition. The action_type side effets
-- / writeback_config columns reference `webhook_definition(id, version)`.
--
-- Plaintext credentials, bearer tokens, API keys, and signed headers are
-- NEVER persisted. They live in Tellus's secrets manager and are referenced
-- via `webhook_secret_reference` rows (one webhook version may have
-- multiple secret references — e.g. one for the auth header, one for a
-- signing key).
--
-- Phase 1 lands ONLY storage. Phase 3 wires up the CRUD endpoints, secret
-- resolution, SSRF hardening, rate limiting, circuit breaking, the FE
-- picker. New action_type rows MAY already reference a webhook_id+version
-- if a webhook_definition row exists for them; the validator allows it.
--
-- Design notes:
--   * `webhook_version` is monotonic per (ontology_id, webhook_name).
--     An UPDATE never overwrites; a new versioned row is inserted. This
--     makes the action_type -> webhook reference immutable for life.
--   * `status` controls whether new action types may select this version.
--     `'disabled'` prevents new bindings but keeps existing action types
--     working (the runtime reads each invocation's persisted version).
--   * `endpoint_config` is a JSONB blob carrying the URL, redirect policy,
--     and header allowlist. The application layer enforces HTTPS-in-prod
--     and SSRF rules; the DB only stores what the app validated.
--   * `authentication_config` is structural only — a SecretReference. The
--     `webhook_secret_reference` table materialises the secrets row-by-row
--     so revocation auditing is per-secret.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_definition (
  webhook_id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id          UUID         NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,

  -- Stable, ontology-scoped name. The immutable identifier an action_type
  -- writes into its config (along with `version`).
  name                 TEXT         NOT NULL,

  -- Monotonic per (ontology_id, name). Bumped by the application on every
  -- configuration change. A new row is inserted for each new version —
  -- this table is effectively append-only-by-convention.
  version              INTEGER      NOT NULL CHECK (version >= 1),

  description          TEXT,

  -- Lifecycle. `'draft'` — invisible to action_type bindings. `'active'`
  -- — selectable by new action types; invoked at execution. `'disabled'`
  -- — runtime stops calling; existing action types keep their persisted
  -- version reference and will surface "webhook disabled" errors.
  status               TEXT         NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'disabled')),

  method               TEXT         NOT NULL CHECK (method IN ('GET','POST','PUT','PATCH','DELETE')),

  -- { url, followRedirects?, allowedHosts?[], headerAllowlist?[] }
  endpoint_config      JSONB        NOT NULL,

  -- JSON Schema (draft 2020-12) for the request body the action type
  -- constructs from its side-effect / writeback input mapping.
  input_schema         JSONB        NOT NULL,

  -- Optional JSON Schema for the response body. Required for writeback
  -- webhooks (their output bindings are validated against this at save
  -- time). NULL for side-effect webhooks (response is ignored).
  output_schema        JSONB,

  -- { kind: 'tellus_secret' | 'external_reference', ref, key? } — NEVER
  -- the plaintext credential. Multiple rows in webhook_secret_reference
  -- (below) carry the materialised references for this version.
  authentication_config JSONB       NOT NULL,

  timeout_ms           INTEGER      NOT NULL CHECK (timeout_ms BETWEEN 100 AND 300000),
  max_response_bytes   INTEGER      NOT NULL CHECK (max_response_bytes BETWEEN 0 AND 10485760),

  -- { maxAttempts, initialBackoffMs, maxBackoffMs, multiplier, jitterMs }.
  -- NULL: no retries (single attempt). The outbox worker honours this.
  retry_policy         JSONB,

  created_by           TEXT         NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- One active/draft version per (ontology_id, name). Disabled versions
  -- keep their (ontology_id, name, version) row; the partial index lets
  -- the application layer pick the "live" version in O(1) by name.
  UNIQUE (ontology_id, name, version),

  -- Name follows UpperCamel like every other ontology resource.
  CHECK (name ~ '^[A-Z][a-zA-Z0-9]*$')
);

-- One (ontology_id, name) has at most one row per status in {draft,
-- active}; a `disabled` row means the (ontology_id, name) has at least
-- one historical version no longer callable but still present for audit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_definition_live_name
  ON webhook_definition(ontology_id, name)
  WHERE status IN ('draft', 'active');

-- Hot lookup: "given an (ontology_id, name, version) reference from an
-- action type, find the immutable webhook row in O(log n)."
CREATE INDEX IF NOT EXISTS idx_webhook_definition_lookup
  ON webhook_definition(ontology_id, name, version);

-- Index for "all webhooks in an ontology" (FE picker list).
CREATE INDEX IF NOT EXISTS idx_webhook_definition_ontology_status
  ON webhook_definition(ontology_id, status, name);

-- ---------------------------------------------------------------------------
-- Materialised secret references (one row per secret used by a version).
-- Separate from the JSONB summary in `authentication_config` so that
--operator audit / revocation can list every webhook version that used a
-- given secret reference without parsing JSONB.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_secret_reference (
  webhook_secret_reference_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id                    UUID        NOT NULL REFERENCES webhook_definition(webhook_id) ON DELETE CASCADE,

  -- Stable name within the webhook version: 'AuthorizationHeader',
  -- 'XSignatureKey', 'BasicAuthUser' … The transport reads the secret
  -- and inserts it into the request under this name (header or body
  -- field, per the application transport layer — Phase 3).
  secret_name                   TEXT        NOT NULL,

  -- { kind, ref, key? } — NEVER the plaintext value.
  secret_reference              JSONB       NOT NULL,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (webhook_id, secret_name)
);

CREATE INDEX IF NOT EXISTS idx_webhook_secret_reference_webhook
  ON webhook_secret_reference(webhook_id);

COMMENT ON TABLE webhook_definition IS
  'Governed, versioned, immutable-after-publish webhook registry. Action types reference a webhook by (ontology_id, name, version); the immutable (ontology_id, name, version) tuple is unique. Plaintext credentials are NEVER stored — only SecretReference documents that the application layer resolves at execution. SSRF hardening, rate limiting, and circuit breaking are enforced at the transport layer, not here.';
COMMENT ON COLUMN webhook_definition.version IS
  'Monotonic integer per (ontology_id, name). Bumped on every configuration change; a new row is appended for each new version so existing action type references remain stable for the life of the action type.';
COMMENT ON COLUMN webhook_definition.output_schema IS
  'JSON Schema (draft 2020-12) for the webhook response body. Required for writeback webhooks whose typed output bindings are validated against this at action type SAVE time. NULL for side-effect webhooks (their responses are not consumed by rules).';
COMMENT ON COLUMN webhook_definition.authentication_config IS
  'Structural SecretReference summary (never the plaintext credential). The webhook_secret_reference table carries materialised rows for per-secret audit and revocation.';
COMMENT ON TABLE webhook_secret_reference IS
  'One row per stable secret-name used by a webhook version. Decoupled from the JSONB authentication_config summary so revocation auditing can list every version that referenced a given secret without parsing JSONB.';
