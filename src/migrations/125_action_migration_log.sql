-- ---------------------------------------------------------------------------
-- Migration 125 — Action Migration Log (Stage A)
--
-- Durable, tamper-evident audit ledger for v1→v2 action-type semantics
-- migrations. Each row records one operator-driven migration (or rollback)
-- of a single action type, including the previous + resulting full action
-- definitions (immutable snapshots), the actor, a correlation id, the
-- acknowledged warning codes, the delete-policy transition, and the
-- previous + resulting definition hashes (content-addressed, computed in
-- the application layer from the canonical JSON of the definition-bearing
-- columns).
--
-- The table is append-only. Rollback writes a NEW row whose
-- `migration_kind = 'rollback'` and whose `previous_definition_snapshot` is
-- the v2 definition being reverted; this preserves a complete, reversible
-- history without mutating existing rows.
--
-- No FK to action_type: an action type may be deleted while the migration
-- history is retained for compliance. `ontology_id` + `action_api_name` +
-- `created_at` are the lookup keys.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_migration_log (
  migration_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id            UUID NOT NULL,
  action_api_name        TEXT NOT NULL,
  migration_kind         TEXT NOT NULL CHECK (migration_kind IN ('migrate', 'rollback')),
  -- Semantics transition.
  previous_semantics_version SMALLINT NOT NULL,
  resulting_semantics_version SMALLINT NOT NULL,
  previous_delete_policy     TEXT NOT NULL,
  resulting_delete_policy    TEXT NOT NULL,
  -- Content-addressed hashes of the previous + resulting definitions.
  previous_definition_hash    TEXT NOT NULL,
  resulting_definition_hash  TEXT NOT NULL,
  -- Immutable full-definition snapshots.
  previous_definition_snapshot JSONB NOT NULL,
  resulting_definition_snapshot JSONB NOT NULL,
  -- Per-parameter change summary (serializable list of ParameterMigration).
  parameter_changes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Finding codes the operator acknowledged (review-required findings only).
  acknowledged_finding_codes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Whether a compatibility adapter was enabled for this migration.
  adapter_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  -- Actor + correlation.
  actor                     TEXT NOT NULL,
  correlation_id            UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for "latest migration for this action" lookups (rollback path).
CREATE INDEX IF NOT EXISTS idx_action_migration_log_action
  ON action_migration_log(ontology_id, action_api_name, created_at DESC);

-- Index for audit forensics (operator audits).
CREATE INDEX IF NOT EXISTS idx_action_migration_log_actor
  ON action_migration_log(actor, created_at DESC);

COMMENT ON TABLE action_migration_log IS
  'Tamper-evident, append-only ledger of v1→v2 action-type semantics migrations and rollbacks. Each row carries an immutable previous + resulting definition snapshot, the actor, correlation id, acknowledged warning codes, and the delete-policy transition. Used for compliance, rollback, and concurrency control (the previous_definition_hash doubles as the optimistic-concurrency token enforced by the migration endpoint).';
COMMENT ON COLUMN action_migration_log.migration_kind IS
  '''migrate'' for a v1→v2 upgrade; ''rollback'' for a revert to a previous snapshot. Rollback writes a NEW row (append-only) and restores the definition through the normal domain validation path, never via direct SQL.';
COMMENT ON COLUMN action_migration_log.previous_definition_hash IS
  'sha256 over the canonical JSON of the previous action-type''s definition-bearing columns (parameters, rules, semantics triple). Doubles as the optimistic-concurrency token the migration endpoint requires onPersist.';
