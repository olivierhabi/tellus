-- Atomic, ontology-scoped counters for generated Action Type identifiers.
-- Values may have gaps after a failed transaction, but can never repeat.
CREATE TABLE IF NOT EXISTS action_generated_sequence (
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  sequence_key TEXT NOT NULL,
  next_value BIGINT NOT NULL CHECK (next_value > 0),
  PRIMARY KEY (ontology_id, sequence_key)
);

COMMENT ON TABLE action_generated_sequence IS
  'Atomic counters used by createObject rules with source=generatedSequence.';
