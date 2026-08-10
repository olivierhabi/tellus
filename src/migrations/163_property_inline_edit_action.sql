-- 163_property_inline_edit_action.sql
-- Pillar 1: Ontology-level per-property inline-edit binding.
-- Each property may have at most one inline-edit action type (nullable reference).
-- The same action type may be reused across multiple properties.
-- Defense in depth: the PUT endpoint + validateInlineEditEligibility enforce
-- that only eligible action types can be bound here; the FK ensures the
-- referenced action type exists.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS inline_edit_action_id TEXT;
