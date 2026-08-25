CREATE TABLE IF NOT EXISTS automation_condition_evaluation (
  evaluation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL,
  automation_version INTEGER NOT NULL,
  evaluation_key TEXT NOT NULL UNIQUE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','running','succeeded','failed','cancelled')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  cursor TEXT,
  examined_count BIGINT NOT NULL DEFAULT 0,
  matched_count BIGINT NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (automation_id, automation_version)
    REFERENCES automation_version(automation_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_automation_condition_evaluation_claim
  ON automation_condition_evaluation (scheduled_for, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_automation_condition_evaluation_lease
  ON automation_condition_evaluation (lease_expires_at)
  WHERE status IN ('claimed','running');

CREATE TABLE IF NOT EXISTS automation_object_membership (
  automation_id UUID NOT NULL,
  automation_version INTEGER NOT NULL,
  object_type_api_name TEXT NOT NULL,
  primary_key TEXT NOT NULL,
  object_rid TEXT,
  value_hash TEXT,
  selected_values JSONB,
  present BOOLEAN NOT NULL DEFAULT true,
  last_event_sequence BIGINT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (
    automation_id, automation_version, object_type_api_name, primary_key
  ),
  FOREIGN KEY (automation_id, automation_version)
    REFERENCES automation_version(automation_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_membership_present
  ON automation_object_membership (automation_id, automation_version, present);

COMMENT ON TABLE automation_condition_evaluation IS
  'Durable scheduled object-set/threshold evaluations claimed independently from the schedule scanner.';
