-- ---------------------------------------------------------------------------
-- 165 — Automate effect pinning: action-type definition history
--
-- action_type.definition_hash exists since migration 132 but was never
-- written by the application layer (the backfill script it referenced was
-- never shipped). The pin machinery needs TWO persisted artifacts per
-- definition version so Automate activation validation can do MORE than
-- raw version equality:
--
--   1. action_type.definition_hash      — fast "identical" check
--      (content-addressed; written by models/actionType.ts on every save),
--   2. action_type_definition_history   — immutable per-version snapshot of
--      the canonical semantic definition, so a pin at version N can still
--      be structurally compared against the CURRENT definition even after
--      action_type itself has moved on (needed for compatible/breaking
--      classification, bulk re-pin, and edit-time blast radius).
--
-- The history backfill below snapshots each existing action type at its
-- CURRENT definition_version with definition_hash left NULL: the app layer
-- recomputes + persists the real hash on the next save (lazy self-heal);
-- a NULL hash always falls back to conservative legacy validation, never
-- to silent acceptance.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS action_type_definition_history (
  action_type_id    UUID        NOT NULL REFERENCES action_type(action_type_id) ON DELETE CASCADE,
  definition_version INTEGER    NOT NULL,
  definition_hash   TEXT,
  definition        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (action_type_id, definition_version)
);

COMMENT ON TABLE action_type_definition_history IS
  'Immutable snapshots of canonical action-type definitions per definition_version. Written by models/actionType.ts syncDefinitionPinArtifacts on every save; consumed by Automate validation/repin/classification.';

COMMENT ON COLUMN action_type_definition_history.definition IS
  'canonicalizeActionDefinition() output (semantic subset; no display metadata).';

-- Initial snapshot of every existing action type at its current version.
-- definition_hash stays NULL until the next app-layer save recomputes it
-- (SQL cannot reproduce the TS canonical hash byte-exactly; correctness
-- needs one implementation).
INSERT INTO action_type_definition_history (
  action_type_id, definition_version, definition_hash, definition
)
SELECT action_type_id,
       COALESCE(definition_version, 1),
       NULL,
       jsonb_build_object(
         'parameters', COALESCE(parameters, '[]'::jsonb),
         'rules', COALESCE(rules, '[]'::jsonb)
       )
  FROM action_type
ON CONFLICT (action_type_id, definition_version) DO NOTHING;

-- Fleet-scale lookups for repin + blast-radius queries (jsonb containment
-- on the effects array inside definitions).
CREATE INDEX IF NOT EXISTS automation_draft_action_pins_gin
  ON automation USING gin ((draft_definition -> 'effects') jsonb_path_ops);

CREATE INDEX IF NOT EXISTS automation_version_action_pins_gin
  ON automation_version USING gin ((definition -> 'effects') jsonb_path_ops);
