-- ---------------------------------------------------------------------------
-- Migration 032: Code Repositories — audit + idempotency
--
-- Closes the durable-before-ack + tamper-evident half of §1.10 and the
-- idempotency-replay half of §1.4 for the Code Repositories surface
-- (Stemma, Code Repository Service, Templates, Resource Imports, OSDK
-- Generator, Jemma, JobSpec Publisher, Functions Registry, Live Preview,
-- Stemma Events).
--
-- We deliberately do NOT extend the existing `action_audit_log` chain
-- (migration 036) because:
--
--   1. action_audit_log is bound to the Actions/Ontology subsystem (it
--      requires action_type_api_name, execution_id, affected_objects).
--      Code-repo events have no Action; squeezing them into that schema
--      would either lose fields (target_type, before_hash, after_hash)
--      or pollute the Actions analytics.
--
--   2. We want a hard isolation boundary so a defect in the Code Repos
--      writer cannot corrupt the Actions chain. Two parallel chains with
--      independent advisory-lock keys is safer than one shared chain
--      under a single lock.
--
--   3. Forwards-compatibility: the §1.10 spec calls for FedRAMP-grade
--      retention (7 years) plus before_hash/after_hash on mutations.
--      action_audit_log row_hash already covers tamper-evidence; what we
--      add here is per-event before/after content hashes that prove what
--      the resource looked like immediately before and after the change.
--
-- The pattern (advisory lock + singleton head + sha256(prev || canon))
-- is identical to migration 036; only the lock key, the head pointer
-- table, and the event row schema differ.
--
-- Lock key derivation:
--   Postgres: SELECT hashtext('tellus.code_repos.audit.hash_head');
--   Result:   2059623761 (verified by tests/unit/code-repos/audit/lock-key-unit.test.ts)
--
-- Idempotency rationale:
--   Per G-C-20..23, every POST that mutates state requires Idempotency-Key.
--   We dedup on the composite (principal_user_id, key) because a key is
--   per-user-scoped — two users can legitimately reuse the same UUID. The
--   request_hash column lets us return 409 IdempotencyConflict when the
--   same key arrives with a different body (G-C-22). TTL is enforced via
--   expires_at (created_at + 24h) plus a partial index for fast purge.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 032.1 code_repos_audit_events — the chain table.
--
-- Columns are immutable after INSERT. Every mutating Code Repos endpoint
-- writes exactly one row inside the same transaction as the data edit,
-- guaranteeing durable-before-ack: if the audit insert fails, the data
-- edit rolls back with it.
-- ---------------------------------------------------------------------------
CREATE TABLE code_repos_audit_events (
  audit_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Sequential index over the chain. BIGSERIAL guarantees monotonic order
  -- under SERIALIZABLE writers; the verifier walks by seq ASC.
  seq                 BIGSERIAL   NOT NULL UNIQUE,
  -- Event taxonomy. category coarse-grained (stemma|code_repo|jemma|...);
  -- action verbose (createRepository, updateRefs, ...). Both NOT NULL.
  category            TEXT        NOT NULL CHECK (category ~ '^[a-z][a-z_]{0,31}$'),
  action              TEXT        NOT NULL CHECK (action ~ '^[a-z][A-Za-z0-9.]{0,63}$'),
  -- Target resource. RID format enforced; target_type is for downstream
  -- analytics (objectType for the Foundry-style "this audit pertains to
  -- a Repository / a JobSpec / a FunctionVersion" facet).
  target_rid          TEXT        NOT NULL CHECK (target_rid ~ '^ri\.([a-z][a-z0-9-]*)\.([a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(.+)$'),
  target_type         TEXT        NOT NULL CHECK (target_type ~ '^[A-Z][a-zA-Z0-9]{0,63}$'),
  -- Principal. NOT NULL because system-initiated mutations write a
  -- synthetic principal ('system' / 'gc' / 'verifier').
  principal_user_id   TEXT        NOT NULL,
  principal_source    TEXT        NOT NULL CHECK (principal_source IN ('cookie', 'bearer-jwt', 'pat', 'system')),
  -- SUCCESS only — failure paths roll back the whole transaction so an
  -- audit row never describes a failed mutation. We keep the column
  -- enumerated for future expansion (e.g. read-event auditing for §1.10
  -- "every read of sensitive RID is auditable" hooks).
  result              TEXT        NOT NULL CHECK (result IN ('SUCCESS')),
  -- §1.4 request correlation. The same uuid surfaces in the response
  -- envelope's requestId field; auditors can join on this column.
  request_id          TEXT        NOT NULL,
  -- §1.10 before/after content hashes — sha256 of canonical_json of the
  -- resource state immediately before and after the mutation. NULL on
  -- create (before) and on delete (after).
  before_hash         TEXT        CHECK (before_hash IS NULL OR before_hash ~ '^[0-9a-f]{64}$'),
  after_hash          TEXT        CHECK (after_hash IS NULL OR after_hash ~ '^[0-9a-f]{64}$'),
  -- Network attribution. Both nullable because system-initiated events
  -- have no client.
  source_ip           TEXT,
  user_agent          TEXT,
  -- Free-form parameters captured from the request. Capped at 16 KB by
  -- application code (canonicalJson rejects deeper structures); the DB
  -- enforces only "valid jsonb".
  parameters          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Hash chain.
  prev_hash           TEXT        NOT NULL,
  row_hash            TEXT        NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE code_repos_audit_events IS
  'Append-only tamper-evident audit log for the Code Repositories surface. Every mutation writes exactly one row inside the same transaction as the data edit (durable-before-ack §1.10). The hash chain (prev_hash, row_hash) is identical in shape to action_audit_log but uses a separate advisory lock key (hashtext(''tellus.code_repos.audit.hash_head'')) to prevent fork-producing concurrent inserts under READ COMMITTED. 7-year retention enforced by archival cron, not the DB.';

-- Index for "audit events for resource X" lookups.
CREATE INDEX code_repos_audit_target_rid_idx
  ON code_repos_audit_events (target_rid, created_at DESC);

-- Index for "audit events by principal" lookups (forensics).
CREATE INDEX code_repos_audit_principal_idx
  ON code_repos_audit_events (principal_user_id, created_at DESC);

-- Index for the daily forward-walk verifier.
CREATE INDEX code_repos_audit_seq_idx
  ON code_repos_audit_events (seq);

-- Index for request-id correlation (response → audit row).
CREATE INDEX code_repos_audit_request_id_idx
  ON code_repos_audit_events (request_id);

-- ---------------------------------------------------------------------------
-- 032.2 code_repos_audit_hash_head — singleton head pointer.
-- ---------------------------------------------------------------------------
CREATE TABLE code_repos_audit_hash_head (
  id              INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  head_hash       TEXT        NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  head_audit_id   UUID        NOT NULL,
  head_seq        BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE code_repos_audit_hash_head IS
  'Singleton pointer to the head of the code_repos_audit_events chain. Writers MUST hold pg_advisory_xact_lock(2059623761) before updating. Guards against fork-producing concurrent inserts under READ COMMITTED.';

-- ---------------------------------------------------------------------------
-- 032.3 Genesis row.
--
-- Seeds the chain with a known anchor so the verifier never needs to
-- special-case "empty chain". audit_id is the all-zero UUID; row_hash is
-- sha256("tellus-code-repos-audit-genesis-v1") computed at migration
-- time for byte-determinism across deploys.
-- ---------------------------------------------------------------------------
INSERT INTO code_repos_audit_events (
  audit_id,
  seq,
  category,
  action,
  target_rid,
  target_type,
  principal_user_id,
  principal_source,
  result,
  request_id,
  before_hash,
  after_hash,
  source_ip,
  user_agent,
  parameters,
  prev_hash,
  row_hash,
  created_at
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  0,
  'system',
  'genesis',
  -- Synthetic genesis RID; matches G-C-01 service segment "audit".
  'ri.tellus.main.audit.genesis',
  'Genesis',
  'system',
  'system',
  'SUCCESS',
  '00000000-0000-0000-0000-000000000000',
  NULL,
  NULL,
  NULL,
  NULL,
  '{}'::jsonb,
  -- prev_hash for the genesis row is the all-zero sha256.
  '0000000000000000000000000000000000000000000000000000000000000000',
  -- sha256("tellus-code-repos-audit-genesis-v1")
  -- Verified by tests/unit/code-repos/audit/genesis-hash-unit.test.ts.
  encode(digest('tellus-code-repos-audit-genesis-v1', 'sha256'), 'hex'),
  '1970-01-01T00:00:00Z'
);

-- Seed the head pointer to the genesis row.
INSERT INTO code_repos_audit_hash_head (
  id, head_hash, head_audit_id, head_seq, updated_at
) VALUES (
  1,
  encode(digest('tellus-code-repos-audit-genesis-v1', 'sha256'), 'hex'),
  '00000000-0000-0000-0000-000000000000',
  0,
  '1970-01-01T00:00:00Z'
);

-- Note on seq=0 genesis row + BIGSERIAL:
-- We INSERTed the genesis row with seq=0 manually, bypassing the sequence.
-- The BIGSERIAL sequence defaults to start at 1; its first nextval() will
-- return 1 regardless of our manual insert. We deliberately do NOT call
-- setval() because Postgres rejects setval(seq, 0, true) (sequences require
-- value >= 1) and there is nothing to bump — the sequence is untouched.
-- Pinned by tests/integration/code-repos/audit/seq-numbering-integration.test.ts.

-- ---------------------------------------------------------------------------
-- 032.4 code_repos_idempotency — POST-replay storage.
--
-- This migration owns the canonical schema for the idempotency table.
-- Migration 031 created a rougher placeholder (key + service + endpoint,
-- no principal scoping) before this contract was finalized; we drop it
-- here and rebuild with the principal-scoped composite PK that G-C-21
-- requires. The DROP CASCADE is safe in production because no service
-- between 031 and 032 deploys writes to that table — it was a forward
-- placeholder, never wired into a route handler.
DROP TABLE IF EXISTS code_repos_idempotency CASCADE;
--
-- Composite primary key (principal_user_id, idem_key) lets two distinct
-- users legitimately reuse the same UUID. request_hash is sha256 of the
-- canonical_json of (method, path, sorted-relevant-headers, body); used
-- to detect "same key, different body" → 409 IdempotencyConflict.
-- ---------------------------------------------------------------------------
CREATE TABLE code_repos_idempotency (
  principal_user_id   TEXT        NOT NULL,
  idem_key            TEXT        NOT NULL CHECK (length(idem_key) >= 1 AND length(idem_key) <= 255),
  request_hash        TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Captured response. Replayed verbatim on retry. Status + body always
  -- present; etag sometimes (mutations that don't expose a versioned
  -- resource have no etag).
  response_status     INTEGER     NOT NULL CHECK (response_status >= 100 AND response_status <= 599),
  response_body       JSONB       NOT NULL,
  response_etag       TEXT,
  -- Audit linkage — the audit row written when this response was first
  -- produced. On replay we do NOT re-emit the audit row; we link instead.
  audit_id            UUID        REFERENCES code_repos_audit_events(audit_id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (principal_user_id, idem_key),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE code_repos_idempotency IS
  'POST-idempotency-key replay storage for the Code Repositories surface. 24h TTL per G-C-23. Replay returns the captured response verbatim; conflict (same key, different request_hash) returns 409 IdempotencyConflict.';

-- Index for the TTL purge cron.
CREATE INDEX code_repos_idempotency_expires_at_idx
  ON code_repos_idempotency (expires_at);
