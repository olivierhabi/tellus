-- ---------------------------------------------------------------------------
-- Migration 128 — Interface Link Constraint (Phase 2 runtime; schema only)
--
-- An `interface_link_constraint` declares a polymorphic, interface-typed
-- relationship contract published by an Interface. Concrete `link_type`s
-- whose source and target object types implement the referenced interfaces
-- are runtime "implementations" of the constraint. Action types reference
-- the constraint (by `apiName`) instead of a concrete link type — the
-- runtime resolver picks the concrete link type(s) at execution time and,
-- for *creation*, fails when more than one concrete implementation
-- ambiguously satisfies the constraint (per the public behavioural spec).
-- For *deletion*, every matching concrete implementation is removed in a
-- deterministic, auditable plan.
--
-- This migration ONLY adds storage. Phase 2 adds the domain types, compiler
-- dispatch, runtime resolver, authorization, and FE authoring against this
-- table. Nothing here is referenced by Phase 1 code paths.
--
-- References:
--   interface             (007_create_interfaces.sql)
--   object_type           (001_initial_schema.sql)
--   ontology              (001_initial_schema.sql)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interface_link_constraint (
  interface_link_constraint_id UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id                  UUID         NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  api_name                     TEXT         NOT NULL,
  display_name                 TEXT         NOT NULL,
  description                  TEXT,

  -- The interface that OWNS this contract (one side of the relationship is
  -- always polymorphic, typed by this interface).
  interface_id                 UUID         NOT NULL REFERENCES interface(interface_id) ON DELETE CASCADE,

  -- The other side: either another interface (interface-to-interface link)
  -- OR a concrete object type (interface-to-object-type link). Exactly one
  -- of the two MUST be non-NULL (enforced by the XOR CHECK below).
  target_interface_id          UUID         REFERENCES interface(interface_id) ON DELETE CASCADE,
  target_object_type_id        UUID         REFERENCES object_type(object_type_id) ON DELETE CASCADE,

  -- Cardinality the concrete link_type MUST implement for this constraint.
  cardinality                  TEXT         NOT NULL CHECK (cardinality IN (
                                            'ONE_TO_ONE', 'ONE_TO_MANY',
                                            'MANY_TO_ONE', 'MANY_TO_MANY')),

  -- Optional symbolic role names on each side. These are documentation +
  -- rendering hints — they are NOT part of the runtime lookup. The runtime
  -- resolves purely by (interface, target-interface|target-object-type,
  -- cardinality, direction) against concrete link_types whose source/target
  -- object types implement the listed interfaces.
  source_role                  TEXT,
  target_role                  TEXT,

  -- Phase 2 will introduce a `status` ('draft' | 'active' | 'deprecated').
  -- Landing the column now lets Phase 1 readers treat NULL as 'draft'.
  status                       TEXT         CHECK (status IS NULL OR status IN ('draft', 'active', 'deprecated')),

  created_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Stable, ontology-scoped apiName.
  UNIQUE (ontology_id, api_name),

  -- XOR: exactly one of the two target-side references must be set.
  CHECK (
    (target_interface_id   IS NOT NULL AND target_object_type_id IS NULL)
    OR
    (target_interface_id   IS NULL     AND target_object_type_id IS NOT NULL)
  ),

  -- api_name follows UpperCamel like every other ontology resource.
  CHECK (api_name ~ '^[A-Z][a-zA-Z0-9]*$')
);

-- Index for "all constraints published by an interface" lookups (runtime
-- resolver's hot path: given an interface, find its link contracts).
CREATE INDEX IF NOT EXISTS idx_interface_link_constraint_interface_id
  ON interface_link_constraint(interface_id);

-- Index for "all constraints in an ontology" (FE authoring list view).
CREATE INDEX IF NOT EXISTS idx_interface_link_constraint_ontology
  ON interface_link_constraint(ontology_id);

-- Index for target-side lookups (the resolver checks both sides; a contract
-- where a given interface appears as the target also matches that interface's
-- types as the LINK SOURCE — see Phase 2 resolver).
CREATE INDEX IF NOT EXISTS idx_interface_link_constraint_target_interface
  ON interface_link_constraint(target_interface_id)
  WHERE target_interface_id IS NOT NULL;

COMMENT ON TABLE interface_link_constraint IS
  'Polymorphic, interface-typed link contract published by an Interface. A concrete link_type whose source and target object_types both implement the referenced interfaces (or one implements an interface and the other is a fixed object type) is a runtime implementation of this constraint. Action rules reference the constraint by apiName; the Phase 2 runtime resolver picks the concrete link_type, failing on ambiguity for creation and removing all matches for deletion.';
COMMENT ON COLUMN interface_link_constraint.api_name IS
  'Stable, ontology-scoped UpperCamel apiName. Persisted in action rule bodies; never changes after creation.';
COMMENT ON COLUMN interface_link_constraint.interface_id IS
  'The interface that OWNS this contract. One side of every relationship typed by this constraint is polymorphic over this interface.';
COMMENT ON COLUMN interface_link_constraint.target_interface_id IS
  'When non-NULL: the other side of the relationship is also polymorphic, typed by this interface (interface-to-interface link). Exactly one of target_interface_id / target_object_type_id must be set (XOR enforced).';
COMMENT ON COLUMN interface_link_constraint.target_object_type_id IS
  'When non-NULL: the other side of the relationship is a fixed object type (interface-to-object-type link). Exactly one of target_interface_id / target_object_type_id must be set (XOR enforced).';
COMMENT ON COLUMN interface_link_constraint.cardinality IS
  'The cardinality the concrete link_type MUST implement. The runtime resolver disambiguates by this + the source/target interface implementation set.';
COMMENT ON COLUMN interface_link_constraint.status IS
  'Lifecycle. NULL or ''draft'' — not yet visible to action rules. ''active'' — available. ''deprecated'' — runtime rejects new action types referencing it; existing action types keep working until the constraint is removed. Phase 2 introduces enforcement of these transitions.';
