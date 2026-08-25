-- ---------------------------------------------------------------------------
-- Migration 130 — Action Type Writeback Configuration (Phase 4 runtime; schema now)
--
-- Adds `action_type.writeback_config` (NULL by default — almost every
-- existing action type has no writeback). Stores a single
-- `ActionWritebackConfig` JSONB blob:
--   { webhookId, webhookVersion, inputs, outputBindings?, failurePolicy:"abort" }
--
-- The spec restricts each Action Type to AT MOST ONE writeback webhook.
-- Enforced as a database invariant: writeback_config, when non-NULL, must
-- be a JSONB *object*, never an array (the array shape would imply N
-- writebacks). The application layer further validates that exactly one
-- webhookId + webhookVersion is referenced; the CHECK here is the
-- structural backstop.
--
-- Phase 1 lands ONLY storage. Phase 4 wires up the pre-edit stage in
-- the action executor, the typed WritebackResponseValueSource, the
-- idempotency key, and the FE writeback config builder.
--
-- Backward compatibility: NULL by default. All 277 existing action types
-- remain valid; nothing is mutated.
-- ---------------------------------------------------------------------------

ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS writeback_config JSONB;

-- Structural backstop: writeback_config is either NULL or a JSON object
-- (i.e. jsonb_typeof = 'object'). Catches any accidental array-shaped
-- payload that would imply multiple writebacks per action type.
ALTER TABLE action_type
  ADD CONSTRAINT action_type_writeback_config_is_object
  CHECK (
    writeback_config IS NULL
    OR jsonb_typeof(writeback_config) = 'object'
  );

-- Structurally requires the canonical fields when a config is present.
-- The application layer enforces the deeper ValueSource + webhook
-- existence + output binding schema validation.
ALTER TABLE action_type
  ADD CONSTRAINT action_type_writeback_config_shape
  CHECK (
    writeback_config IS NULL
    OR (
      (writeback_config ? 'webhookId')
      AND (writeback_config ? 'webhookVersion')
      AND (writeback_config ? 'inputs')
      AND (writeback_config ? 'failurePolicy')
      AND (writeback_config->>'failurePolicy' = 'abort')
    )
  );

COMMENT ON COLUMN action_type.writeback_config IS
  'Single ActionWritebackConfig JSONB or NULL. The pre-edit writeback webhook (Phase 4) executes BEFORE ontology edits; on failure, no edits are applied (failurePolicy:''abort'' is the only supported policy). At most one writeback per action type, enforced structurally (CHECK on jsonb_typeof = ''object'') and by the application layer.';
