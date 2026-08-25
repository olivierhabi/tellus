CREATE TABLE IF NOT EXISTS rwanda_pindo_automation_state (
  ontology_id uuid NOT NULL,
  route_id text NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, route_id)
);

CREATE TABLE IF NOT EXISTS rwanda_pindo_automation_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id uuid NOT NULL,
  route_id text NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL,
  service_identity text NOT NULL DEFAULT 'rwanda-pindo-automation',
  action_execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rwanda_pindo_automation_audit_route_idx
  ON rwanda_pindo_automation_audit (ontology_id, route_id, created_at DESC);
