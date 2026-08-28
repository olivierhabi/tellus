-- Ontology Manager schema working state and atomic commit ledger.
-- Browser storage is only a cache: this server state is authoritative.
BEGIN;

CREATE TABLE IF NOT EXISTS ontology_schema_revision (
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES ontology_branch(branch_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, branch_id)
);

INSERT INTO ontology_schema_revision (ontology_id, branch_id, revision)
SELECT b.ontology_id, b.branch_id, 0 FROM ontology_branch b
ON CONFLICT (ontology_id, branch_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ontology_working_state (
  working_state_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES ontology_branch(branch_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  base_revision BIGINT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ontology_id, branch_id, principal_id)
);

CREATE INDEX IF NOT EXISTS ontology_working_state_principal_idx
  ON ontology_working_state (principal_id, ontology_id, branch_id);

CREATE TABLE IF NOT EXISTS ontology_working_change (
  change_id TEXT NOT NULL,
  working_state_id UUID NOT NULL REFERENCES ontology_working_state(working_state_id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN (
    'objectType','property','linkType','actionType','interface',
    'sharedProperty','group','groupMembership','datasource','binding'
  )),
  resource_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'create','modify','delete','bind','index','migrate','restore','other'
  )),
  base_snapshot JSONB,
  base_revision TEXT,
  proposed_value JSONB,
  patch JSONB,
  summary TEXT NOT NULL,
  dependencies TEXT[] NOT NULL DEFAULT '{}',
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  destructive JSONB,
  resource_url TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (working_state_id, change_id)
);

CREATE INDEX IF NOT EXISTS ontology_working_change_state_resource_idx
  ON ontology_working_change (working_state_id, resource_kind, resource_id);

CREATE TABLE IF NOT EXISTS ontology_saved_change_set (
  change_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES ontology_branch(branch_id) ON DELETE CASCADE,
  base_revision BIGINT NOT NULL,
  saved_revision BIGINT NOT NULL,
  changes JSONB NOT NULL,
  saved_by TEXT NOT NULL,
  commit_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontology_saved_change_set_branch_idx
  ON ontology_saved_change_set (ontology_id, branch_id, saved_revision);

CREATE TABLE IF NOT EXISTS ontology_schema_commit (
  commit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES ontology_branch(branch_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('main','branch')),
  status TEXT NOT NULL CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED')),
  response JSONB,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (principal_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ontology_schema_outbox (
  outbox_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id UUID NOT NULL REFERENCES ontology_schema_commit(commit_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('INDEX_OBJECT_TYPE','START_DATASOURCE_REPLACEMENT','SCHEMA_CHANGED')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SUCCEEDED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (commit_id, event_key)
);

CREATE INDEX IF NOT EXISTS ontology_schema_outbox_pending_idx
  ON ontology_schema_outbox (status, available_at)
  WHERE status IN ('PENDING','FAILED');

-- Server-owned policy input. Commit requests cannot opt out of protection.
CREATE TABLE IF NOT EXISTS ontology_resource_protection (
  ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('objectType','actionType','linkType','interface','sharedProperty')),
  resource_id TEXT NOT NULL,
  protected BOOLEAN NOT NULL DEFAULT true,
  policy_rid TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ontology_id, resource_kind, resource_id)
);

COMMIT;
