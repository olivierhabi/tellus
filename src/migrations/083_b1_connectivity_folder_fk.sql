-- 083_b1_connectivity_folder_fk.sql
--
-- Forward fix for B1 acceptance criterion 5 ("a Compass folder cannot be
-- deleted while a connection still lives in it").
--
-- Migration 074 declares this foreign key, but on environments where 074 was
-- recorded as applied BEFORE the ALTER clause was added to the file, the
-- constraint is absent from the live schema. The migration runner keys on the
-- filename and never re-applies 074, so the only correct production fix is a
-- forward migration.
--
-- This file uses the plain-SQL idempotent pattern (DROP IF EXISTS then ADD) so
-- it is safe to run on databases where 074 already created the constraint as
-- well as on databases where it is missing.
--
-- compass_folder_rid (text) -> resources.rid (text, PK). ON DELETE RESTRICT is
-- what makes the folder deletion fail at the database layer; ON UPDATE CASCADE
-- keeps the reference correct if a folder RID is ever rewritten.

-- Drop BOTH possible prior names so fresh databases (where 074 already added
-- the FK under its own name) and stale databases (where the FK is missing)
-- converge to exactly one canonical constraint. 074 names it
-- `connectivity_connections_folder_fk`; the canonical name below is used
-- everywhere going forward.
ALTER TABLE connectivity_connections
  DROP CONSTRAINT IF EXISTS connectivity_connections_folder_fk;

ALTER TABLE connectivity_connections
  DROP CONSTRAINT IF EXISTS connectivity_connections_compass_folder_rid_fkey;

ALTER TABLE connectivity_connections
  ADD CONSTRAINT connectivity_connections_compass_folder_rid_fkey
  FOREIGN KEY (compass_folder_rid)
  REFERENCES resources (rid)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

-- Supporting index for the FK lookup / RESTRICT check. Without it, every
-- folder delete would sequential-scan connectivity_connections.
CREATE INDEX IF NOT EXISTS idx_connectivity_connections_compass_folder_rid
  ON connectivity_connections (compass_folder_rid);
