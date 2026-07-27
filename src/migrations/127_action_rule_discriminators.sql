-- ---------------------------------------------------------------------------
-- Migration 127 — Action Rule Discriminator Constraint
--
-- Enforces that every entry of `action_type.rules` is a JSON object with a
-- `type` field whose value is a member of the canonical Action Rule
-- Discriminator set:
--     createObject, modifyObject, modifyOrCreateObject, deleteObject,
--     addLink, removeLink, createInterfaceLink, deleteInterfaceLink
--
-- These are the only rule kinds the rule compiler, runtime executor, and
-- audit pipeline recognise. The constraint is data-additive: no existing
-- row is mutated, all currently-stored rule types (createObject, modifyObject,
-- modifyOrCreateObject, deleteObject, addLink, removeLink) appear in the
-- allowlist so no seed action is rejected. The two new interface-link
-- discriminators (createInterfaceLink, deleteInterfaceLink) are reserved
-- for Phase 2 — they are accepted by storage as soon as this migration
-- lands even though the compiler does not yet dispatch them.
--
-- The constraint is implemented via an IMMUTABLE helper function so the
-- CHECK can iterate the JSONB array (Postgres CHECK constraints cannot
-- contain subqueries directly, but they can call IMMUTABLE functions that
-- do). The function is declared IMMUTABLE because it depends only on its
-- argument and the static allowlist — no catalog or environment reads.
-- ---------------------------------------------------------------------------

-- 1. Helper function --------------------------------------------------------

CREATE OR REPLACE FUNCTION action_rule_discriminator_valid(rules jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    jsonb_typeof(rules) = 'array'
    AND (
      SELECT bool_and(
               t.elem ? 'type'
               AND jsonb_typeof(t.elem->'type') = 'string'
               AND t.elem->>'type' IN (
                 'createObject',
                 'modifyObject',
                 'modifyOrCreateObject',
                 'deleteObject',
                 'addLink',
                 'removeLink',
                 'createInterfaceLink',
                 'deleteInterfaceLink'
               )
             )
      FROM jsonb_array_elements(rules) AS t(elem)
    )
$$;

COMMENT ON FUNCTION action_rule_discriminator_valid(jsonb) IS
  'IMMUTABLE helper used by the action_type.rules discriminator CHECK constraint. Returns true only when every element of `rules` carries a `type` field whose value is one of the canonical Action Rule Discriminators. Used by the CHECK constraint (subqueries are not permitted inline).';

-- 2. CHECK constraint -------------------------------------------------------

-- Existing rows are back-validated by PostgreSQL when ALTER TABLE ADD
-- CONSTRAINT CHECK runs. Every currently-stored rule type is in the
-- allowlist so the constraint is satisfied without a backfill.

ALTER TABLE action_type
  ADD CONSTRAINT action_type_rules_discriminators_valid
  CHECK (action_rule_discriminator_valid(rules));

COMMENT ON CONSTRAINT action_type_rules_discriminators_valid ON action_type IS
  'Every element of action_type.rules MUST have a `type` field whose value is a member of the canonical Action Rule Discriminator set. Phase 1 invariants: createObject, modifyObject, modifyOrCreateObject, deleteObject, addLink, removeLink, createInterfaceLink, deleteInterfaceLink.';
