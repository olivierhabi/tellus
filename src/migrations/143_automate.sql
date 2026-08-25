-- Tellus Automate foundation: immutable definitions plus durable operational
-- state. Definitions are validated by the application and stored once per
-- version. Runtime rows always reference the exact version that produced them.

CREATE TABLE IF NOT EXISTS automation (
  automation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rid TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id),
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','paused','muted','disabled','archived')),
  current_version INTEGER,
  draft_definition JSONB NOT NULL,
  draft_revision BIGINT NOT NULL DEFAULT 1,
  owner_security_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  muted_at TIMESTAMPTZ,
  mute_reason TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (current_version IS NULL OR current_version > 0)
);

CREATE INDEX IF NOT EXISTS idx_automation_owner
  ON automation (tenant_id, owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_ontology
  ON automation (tenant_id, ontology_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_due
  ON automation (next_run_at, automation_id)
  WHERE status IN ('active','muted') AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_version (
  automation_id UUID NOT NULL REFERENCES automation(automation_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  definition JSONB NOT NULL,
  definition_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, version),
  UNIQUE (automation_id, definition_hash)
);

CREATE TABLE IF NOT EXISTS automation_dependency (
  child_automation_id UUID PRIMARY KEY REFERENCES automation(automation_id) ON DELETE CASCADE,
  parent_automation_id UUID NOT NULL REFERENCES automation(automation_id) ON DELETE RESTRICT,
  child_version INTEGER NOT NULL,
  delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 86400),
  completion_statuses TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (child_automation_id <> parent_automation_id),
  FOREIGN KEY (child_automation_id, child_version)
    REFERENCES automation_version(automation_id, version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_dependency_parent
  ON automation_dependency (parent_automation_id);

CREATE TABLE IF NOT EXISTS automation_condition_state (
  automation_id UUID NOT NULL,
  automation_version INTEGER NOT NULL,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_evaluated_at TIMESTAMPTZ,
  last_event_sequence BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, automation_version),
  FOREIGN KEY (automation_id, automation_version)
    REFERENCES automation_version(automation_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_trigger_event (
  trigger_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL,
  automation_version INTEGER NOT NULL,
  trigger_key TEXT NOT NULL UNIQUE,
  trigger_type TEXT NOT NULL,
  condition_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','partially_failed',
                      'failed','cancelled','skipped')),
  scheduled_for TIMESTAMPTZ,
  caused_by_trigger_event_id UUID REFERENCES automation_trigger_event(trigger_event_id),
  retry_of_trigger_event_id UUID REFERENCES automation_trigger_event(trigger_event_id),
  execution_principal JSONB NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (automation_id, automation_version)
    REFERENCES automation_version(automation_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_automation_trigger_history
  ON automation_trigger_event (automation_id, created_at DESC, trigger_event_id);
CREATE INDEX IF NOT EXISTS idx_automation_trigger_status
  ON automation_trigger_event (status, created_at);

CREATE TABLE IF NOT EXISTS automation_effect_execution (
  effect_execution_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_event_id UUID NOT NULL REFERENCES automation_trigger_event(trigger_event_id) ON DELETE CASCADE,
  effect_id UUID NOT NULL,
  parent_effect_execution_id UUID REFERENCES automation_effect_execution(effect_execution_id),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('action','function','logic','notification')),
  effect_order INTEGER NOT NULL CHECK (effect_order >= 0),
  is_fallback BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','running','retrying','succeeded',
                      'failed','exhausted','skipped','cancelled')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error_code TEXT,
  error_message TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trigger_event_id, effect_id, is_fallback)
);
CREATE INDEX IF NOT EXISTS idx_automation_effect_claim
  ON automation_effect_execution (next_attempt_at, created_at)
  WHERE status IN ('pending','retrying');
CREATE INDEX IF NOT EXISTS idx_automation_effect_lease
  ON automation_effect_execution (lease_expires_at)
  WHERE status IN ('claimed','running');

CREATE TABLE IF NOT EXISTS automation_effect_attempt (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_execution_id UUID NOT NULL REFERENCES automation_effect_execution(effect_execution_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
  idempotency_key TEXT NOT NULL,
  external_execution_id TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN,
  next_retry_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (effect_execution_id, attempt_number),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS automation_idempotency (
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  automation_id UUID NOT NULL REFERENCES automation(automation_id) ON DELETE CASCADE,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, owner_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS automation_audit_event (
  audit_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  automation_id UUID NOT NULL REFERENCES automation(automation_id) ON DELETE CASCADE,
  automation_version INTEGER,
  actor_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','failed')),
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automation_audit_history
  ON automation_audit_event (automation_id, created_at DESC);

COMMENT ON TABLE automation_version IS
  'Immutable, validated Automate definitions. Runtime records reference the exact version used for an evaluation.';
COMMENT ON TABLE automation_effect_execution IS
  'Durable effect jobs. Workers claim due rows with leases and SKIP LOCKED; retries survive process restarts.';
COMMENT ON COLUMN automation_trigger_event.trigger_key IS
  'Stable condition occurrence identity used to deduplicate scheduler/event redelivery.';
