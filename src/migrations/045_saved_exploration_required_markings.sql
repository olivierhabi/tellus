-- ---------------------------------------------------------------------------
-- T-08 — Saved Explorations: marking-aware visibility filter (H-11).
--
-- Adds `required_markings TEXT[]` to `saved_exploration` so that single-GET
-- and list endpoints can filter out explorations whose saved `config:jsonb`
-- references object types or properties tagged with markings the caller
-- does not hold. The previous read path filtered only on visibility
-- (private/shared/public) and ignored the marking dimension, so a user
-- without SECRET could read an exploration whose filter referenced a
-- SECRET-tagged property.
--
-- Also adds `property.marking_required` (column-level marking) which
-- T-08's `configMarkingResolver` needs to walk filtered properties.
-- The previous schema only carried marking metadata at the object_type
-- level (migration 044), but Foundry's column-level security model
-- requires per-property markings — a filter that names a column whose
-- type isn't otherwise gated still needs a marking check.
--
-- Backfill: existing rows default to '{}' (no markings required). A
-- one-time backfill job (see backfillRequiredMarkings in
-- src/services/explorations/configMarkingResolver.ts; out-of-band
-- script) recomputes the value by re-running resolveRequiredMarkings
-- over the saved `config`. Until backfilled, an existing exploration
-- is visible to anyone who passes the visibility filter — the worst
-- case is the pre-T-08 leak, NOT a regression.
--
-- GIN indexes cover the `required_markings <@ user_markings::text[]`
-- containment predicate the read paths use, plus the analogous predicate
-- on `property.marking_required`.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE saved_exploration
  ADD COLUMN IF NOT EXISTS required_markings TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_saved_exploration_markings_gin
  ON saved_exploration USING GIN (required_markings);

-- property.marking_required (column-level security). Mirrors
-- object_type.marking_required (added by migration 044). NULL = no
-- requirement = visible to all callers — same convention as 044.
--
-- A pre-existing schema may already have property.marking_required as a
-- scalar TEXT (single-marking column). Convert to TEXT[] in-place so the
-- GIN containment predicate applies. NULL stays NULL; non-NULL becomes
-- a single-element array. This is reversible (down path collapses the
-- array back to a scalar via element [1]).
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type INTO col_type
  FROM information_schema.columns
  WHERE table_name = 'property' AND column_name = 'marking_required';

  IF col_type IS NULL THEN
    -- Column does not exist — add as text[]
    ALTER TABLE property ADD COLUMN marking_required TEXT[];
  ELSIF col_type = 'text' THEN
    -- Column exists as scalar — convert in-place
    ALTER TABLE property
      ALTER COLUMN marking_required TYPE TEXT[]
      USING CASE
        WHEN marking_required IS NULL THEN NULL
        ELSE ARRAY[marking_required]
      END;
  ELSIF col_type = 'ARRAY' THEN
    -- Already text[] from a prior re-apply — no-op.
    NULL;
  ELSE
    RAISE EXCEPTION 'property.marking_required has unexpected type: %', col_type;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_property_marking_gin
  ON property USING GIN (marking_required);

COMMIT;
