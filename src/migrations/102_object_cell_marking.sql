-- ---------------------------------------------------------------------------
-- Migration 102: Cell-level security markings (FOUNDRY-GAPS §8)
--
-- Completes the markings granularity ladder. Until now markings could be
-- attached at four levels:
--   * dataset          — foundry_datasets.markings              (mig: deploy gate)
--   * object type       — object_type.marking_required           (mig 044)
--   * column / property — property.marking_required              (mig 045)
--   * row               — object_instances.markings (_security)  (securityContext)
--
-- The missing rung is the Foundry CELL: a single (object instance, property)
-- intersection carrying its OWN marking, independent of the column-wide one.
-- Example: the `salary` column is public, but ONE taxpayer's salary cell is
-- SECRET. Column-level markings can't express that without hiding the column
-- for everyone; cell markings can.
--
-- Enforcement (read time): a caller sees a cell iff their granted markings are
-- a SUPERSET of the cell's markings (the same AND-composition as the row-level
-- `userSees` predicate). Otherwise the property value is redacted to NULL on
-- the way out. A `markingBypass` principal (superadmin / system) sees all.
--
-- The PK is (object_type_api_name, primary_key, property_api_name): this
-- deployment runs the single-enterprise-ontology model, and object type
-- api_names are unique, so the read path (which is keyed by object type +
-- primary key, no ontology in the route) can resolve cell markings without an
-- ontology id. `ontology_id` is kept as an optional context column for
-- forward-compatibility with a multi-ontology deployment.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS object_cell_marking (
  object_type_api_name  TEXT        NOT NULL,
  primary_key           TEXT        NOT NULL,
  property_api_name     TEXT        NOT NULL,
  markings              TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  ontology_id           UUID,
  set_by                TEXT        NOT NULL DEFAULT 'system',
  set_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type_api_name, primary_key, property_api_name)
);

COMMENT ON TABLE object_cell_marking IS
  'FOUNDRY-GAPS §8 cell-level security markings. One row per (object instance, property) that carries a per-cell marking set, enforced at read time by redacting the property value to NULL when the caller does not hold a superset of the cell markings.';
COMMENT ON COLUMN object_cell_marking.markings IS
  'Markings the caller must ALL hold to see this cell. Empty array = visible to everyone (a tombstone for a previously-marked cell).';

-- Hot path: "give me every cell marking for this one object" (single-object
-- GET) and "...for these objects" (search/list batch). Covering the markings
-- keeps the lookup index-only.
CREATE INDEX IF NOT EXISTS idx_object_cell_marking_object
  ON object_cell_marking (object_type_api_name, primary_key)
  INCLUDE (property_api_name, markings);
