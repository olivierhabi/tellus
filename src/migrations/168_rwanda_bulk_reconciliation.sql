-- Rwanda QA §6.3: durable reconciliation-run replay and settlement-effect
-- business-key reservation.  Reservations are inserted by the action
-- executor's pre-commit hook, so they commit atomically with the transaction
-- reconciliation edit and its audit entry.

CREATE TABLE IF NOT EXISTS rwanda_bulk_reconciliation_run (
  request_id text PRIMARY KEY,
  ontology_id text NOT NULL,
  action_type_api_name text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rwanda_bulk_reconciliation_business_key (
  ontology_id text NOT NULL,
  transaction_id text NOT NULL,
  batch_id text NOT NULL,
  request_id text NOT NULL REFERENCES rwanda_bulk_reconciliation_run(request_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, transaction_id, batch_id)
);

COMMENT ON TABLE rwanda_bulk_reconciliation_run IS
  'Rwanda QA §6.3 immutable response replay keyed by client requestId.';
COMMENT ON TABLE rwanda_bulk_reconciliation_business_key IS
  'Rwanda QA §6.3 exactly-once settlement-effect key: transaction plus settlement batch.';
