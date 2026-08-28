-- Reconciliation for ontology_working_change primary key.
--
-- Migration 065_b4_quiver_working_state.sql created this table with
-- PRIMARY KEY (change_id). 175_ontology_manager_working_state.sql uses
-- CREATE TABLE IF NOT EXISTS, so deployments that predated it never
-- received the composite key (working_state_id, change_id) that the
-- working-state service requires for principal-scoped upserts
-- (ON CONFLICT (working_state_id, change_id)). Postgres then rejects
-- every stage request with:
--   "there is no unique or exclusion constraint matching the ON
--    CONFLICT specification"
--
-- This migration converges both fresh and legacy databases to the
-- composite key. It is idempotent: if the constraint already matches,
-- nothing runs. Because legacy single-column keys could in theory hold
-- colliding rows once multiple principals stage concurrently, any
-- duplicates are collapsed first, keeping the most recently updated row.

-- Collapse duplicate (working_state_id, change_id) pairs, keeping the
-- newest row per pair. No-op when the table is already unique.
DELETE FROM ontology_working_change a
USING ontology_working_change b
WHERE a.working_state_id = b.working_state_id
  AND a.change_id = b.change_id
  AND a.updated_at < b.updated_at;

DO $$
DECLARE
  pk_columns text;
BEGIN
  SELECT string_agg(attr.attname, ',' ORDER BY k.ord)
    INTO pk_columns
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute attr
    ON attr.attrelid = rel.oid AND attr.attnum = k.attnum
  WHERE con.contype = 'p'
    AND rel.relname = 'ontology_working_change';

  IF pk_columns IS DISTINCT FROM 'working_state_id,change_id' THEN
    IF pk_columns IS NOT NULL THEN
      ALTER TABLE ontology_working_change
        DROP CONSTRAINT ontology_working_change_pkey;
    END IF;
    ALTER TABLE ontology_working_change
      ADD CONSTRAINT ontology_working_change_pkey
      PRIMARY KEY (working_state_id, change_id);
  END IF;
END $$;
