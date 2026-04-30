-- ---------------------------------------------------------------------------
-- Migration 037: Action-type CBAC + required markings
--
-- Closes the schema half of F-P3-18 (CBAC absent on /actions, /search,
-- /audit, /branches) and the markings half of F-P3-19 (M2M traversal
-- bypasses markings).
--
-- Adds three columns to action_type:
--   allowed_principals  JSONB — array of principal selectors that MAY
--                              execute this action. NULL = no allowlist
--                              (subject to denied_principals + markings).
--   denied_principals   JSONB — array of principal selectors that MUST
--                              NOT execute this action. NULL = no denylist.
--   required_markings   TEXT[] — markings the subject MUST hold (subset
--                                relation: subject_markings ⊇ required).
--
-- Principal selector shape (TS spec mirror in src/services/security/cbacPolicy.ts):
--   { "type": "user", "username": "alice" }
--   { "type": "role", "role": "rra-tax-auditor" }
--   { "type": "group", "group": "rra-officers" }
--   { "type": "any" }                                  — matches any subject
--   { "type": "any_authenticated" }                    — matches any non-anonymous subject
--
-- Policy evaluation (cbacPolicy.evaluate):
--   1. If subject is anonymous → DENY unless allowed_principals contains {type:"any"}.
--   2. If denied_principals matches subject → DENY (denylist beats allowlist).
--   3. If allowed_principals is non-null and no entry matches subject → DENY.
--   4. If required_markings is non-empty and subject_markings does not
--      cover it → DENY with reason="markings_insufficient".
--   5. Else → ALLOW.
--
-- Adds cbac_decision_log table for forensic and analysis purposes. Every
-- CBAC decision (allow OR deny) is appended; the audit hash chain
-- (migration 036) does NOT cover this table because CBAC decisions are
-- frequent (every Action invocation) and would dominate the chain. This
-- table is append-only by REVOKE.
-- ---------------------------------------------------------------------------

ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS allowed_principals JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS denied_principals  JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS required_markings  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN action_type.allowed_principals IS
  'Optional principal allowlist. NULL = no allowlist (open subject to denial + markings). When non-null, must be a JSON array of selectors. See src/services/security/cbacPolicy.ts.';

COMMENT ON COLUMN action_type.denied_principals IS
  'Optional principal denylist. Always evaluated before allowlist. Used to revoke access without rewriting the allowlist.';

COMMENT ON COLUMN action_type.required_markings IS
  'Markings the executing subject must hold. Empty array = no markings required. NEVER NULL.';

-- ---------------------------------------------------------------------------
-- CBAC decision log — forensic record of every authorization decision.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cbac_decision_log (
  decision_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject               TEXT NOT NULL,
  subject_kind          TEXT NOT NULL CHECK (subject_kind IN ('user','service','token','anonymous')),
  resource_kind         TEXT NOT NULL,           -- 'action_type','branch','search','audit_query'
  resource_id           TEXT NOT NULL,           -- action_type api_name, branch_id, etc.
  ontology_id           UUID,
  decision              TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason                TEXT NOT NULL,
  policy_version        TEXT NOT NULL DEFAULT 'v1',
  matched_rule          JSONB,                   -- the selector or markings rule that fired
  source_ip             TEXT,
  request_id            TEXT
);

CREATE INDEX IF NOT EXISTS idx_cbac_decision_subject ON cbac_decision_log(subject, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_cbac_decision_resource ON cbac_decision_log(resource_kind, resource_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_cbac_decision_decision ON cbac_decision_log(decision, decided_at DESC);

COMMENT ON TABLE cbac_decision_log IS
  'F-P3-18 forensic record. Every authorization decision (allow OR deny) is appended. Used by the security team for incident review and by the auditor for compliance reports under Rwandan Law 058/2021 Art. 29.';

-- Forbid mutation of historical CBAC decisions (write-once).
REVOKE UPDATE, DELETE ON cbac_decision_log FROM PUBLIC;
