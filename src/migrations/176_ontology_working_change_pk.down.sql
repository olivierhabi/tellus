-- Reverse of 176: restore the legacy single-column primary key.
-- Note: this only succeeds if no duplicate change_id values exist
-- across working states (i.e. the state the database was in before 176).

ALTER TABLE ontology_working_change
  DROP CONSTRAINT IF EXISTS ontology_working_change_pkey;

ALTER TABLE ontology_working_change
  ADD CONSTRAINT ontology_working_change_pkey PRIMARY KEY (change_id);
