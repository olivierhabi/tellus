-- ---------------------------------------------------------------------------
-- Migration 036: Audit log tamper-evidence — hash chain
--
-- Closes F-P3-11 and F-P2-07 (audit durability + tamper-evidence).
--
-- Implements a blockchain-style append-only hash chain over
-- `action_audit_log` so any post-facto modification of a historical row is
-- detectable by a forward walk. This is the code-local component of the
-- audit-contract mandated by Rwandan Law No. 058/2021 Art. 29. External
-- WORM anchoring (daily head-hash signed and persisted to an external
-- object-lock bucket) is a separate integration point documented in
-- docs/AUDIT_CONTRACT.md and Appendix J.
--
-- Contract
-- --------
-- Every INSERT into `action_audit_log` MUST, inside the same PG
-- transaction as the Action edit:
--
--   1. Acquire pg_advisory_xact_lock(AUDIT_HASH_CHAIN_LOCK_KEY) so that
--      writers serialize on the head pointer. This is required because
--      SERIALIZABLE isolation is not globally enabled (see F-P3-01) and
--      the default READ COMMITTED would otherwise permit two concurrent
--      inserts to both read the same `prev_hash` and produce a fork.
--
--   2. SELECT FOR UPDATE on the singleton `audit_hash_head` row. The
--      advisory lock in (1) is the correctness primitive; the row lock is
--      a belt-and-braces guard that also generates a useful `blocked_by`
--      trace in pg_stat_activity under contention.
--
--   3. Compute row_hash = sha256(prev_hash || canonical_json(row_body))
--      where row_body is the deterministic serialization from
--      src/services/audit/canonicalJson.ts.
--
--   4. INSERT the audit row with the computed prev_hash + row_hash.
--
--   5. UPDATE `audit_hash_head` to point at the new row_hash and audit_id.
--
--   6. COMMIT (or ROLLBACK atomically with the Action edit).
--
-- The chain is seeded with a synthetic genesis row (audit_id = all-zeros,
-- prev_hash = NULL, row_hash = sha256("tellus-audit-genesis-v1")). This
-- makes the forward-walk verifier (src/jobs/auditVerifier.ts) able to
-- start from a known anchor instead of having to special-case the first
-- real row.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 036.1 Add hash-chain columns to action_audit_log.
-- ---------------------------------------------------------------------------
ALTER TABLE action_audit_log
  ADD COLUMN IF NOT EXISTS prev_hash TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS row_hash  TEXT DEFAULT NULL;

COMMENT ON COLUMN action_audit_log.prev_hash IS
  'Hash-chain previous pointer. NULL only on the genesis row and on any pre-migration rows awaiting backfill. For all writes after migration 036, MUST equal audit_hash_head.head_hash at the moment of INSERT (guarded by pg_advisory_xact_lock).';

COMMENT ON COLUMN action_audit_log.row_hash IS
  'sha256(prev_hash || canonical_json(row_body)). row_body is the deterministic serialization defined in src/services/audit/canonicalJson.ts and excludes prev_hash, row_hash, and the generated audit_id. Any later mutation of this row that does not update row_hash (and cascade) is detectable by the forward-walk verifier.';

-- ---------------------------------------------------------------------------
-- 036.2 Singleton head pointer.
--
-- Exactly one row (id = 1). Enforced via PRIMARY KEY and a CHECK that the
-- id is always 1. Writers take pg_advisory_xact_lock on the well-known
-- key `AUDIT_HASH_CHAIN_LOCK_KEY` (defined in src/services/audit/hashChain.ts)
-- before touching this row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_hash_head (
  id              INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  head_hash       TEXT        NOT NULL,
  head_audit_id   UUID        NOT NULL,
  head_seq        BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT        NOT NULL DEFAULT 'system'
);

COMMENT ON TABLE audit_hash_head IS
  'Singleton pointer to the head of the action_audit_log hash chain. Exactly one row with id = 1. Writers MUST hold pg_advisory_xact_lock(AUDIT_HASH_CHAIN_LOCK_KEY) before updating. Guards against fork-producing concurrent inserts under READ COMMITTED. See src/services/audit/hashChain.ts for the Node client contract.';

-- ---------------------------------------------------------------------------
-- 036.3 Seed the genesis row if not present.
--
-- Genesis audit_id is the all-zero UUID, prev_hash is NULL, and row_hash
-- is sha256("tellus-audit-genesis-v1") computed at migration time for
-- determinism. The integer 0 is not a valid execution attempt — it is a
-- marker anchor that lets the verifier treat the chain as non-empty
-- before the first real action executes.
-- ---------------------------------------------------------------------------
INSERT INTO action_audit_log (
  audit_id,
  action_type_api_name,
  action_type_display_name,
  execution_id,
  parameters,
  affected_objects,
  affected_object_count,
  result,
  duration_ms,
  executed_by,
  executed_at,
  prev_hash,
  row_hash
)
VALUES (
  '00000000-0000-0000-0000-000000000000'::uuid,
  '__tellus_audit_genesis__',
  'Audit Chain Genesis',
  '00000000-0000-0000-0000-000000000001'::uuid,
  '{}'::jsonb,
  '[]'::jsonb,
  0,
  'success',
  0,
  'system',
  '1970-01-01 00:00:00+00'::timestamptz,
  NULL,
  encode(digest('tellus-audit-genesis-v1', 'sha256'), 'hex')
)
ON CONFLICT (audit_id) DO NOTHING;

-- Seed the head pointer from the genesis row if the head table is empty.
-- pgcrypto's digest() requires the extension — create it idempotently.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO audit_hash_head (id, head_hash, head_audit_id, head_seq, updated_at, updated_by)
VALUES (
  1,
  encode(digest('tellus-audit-genesis-v1', 'sha256'), 'hex'),
  '00000000-0000-0000-0000-000000000000'::uuid,
  0,
  now(),
  'migration-036'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 036.4 Indices for the forward-walk verifier.
--
-- The verifier walks rows in (executed_at, audit_id) order — the audit_id
-- tiebreaker is required because executed_at has millisecond resolution
-- and multiple rows can share a value. Adding audit_id as the secondary
-- key makes the walk deterministic.
--
-- BTREE index on (prev_hash) supports fast detection of a broken chain
-- (rows whose prev_hash does not match any row's row_hash). The verifier
-- uses it to report segment boundaries.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_chain_walk
  ON action_audit_log(executed_at ASC, audit_id ASC);

CREATE INDEX IF NOT EXISTS idx_audit_chain_prev
  ON action_audit_log(prev_hash)
  WHERE prev_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 036.5 NOT NULL constraints deferred to a follow-up migration.
--
-- The columns are added as nullable so that the migration is backward
-- compatible with in-flight application instances that have not yet been
-- restarted with the new audit service code. Once all application nodes
-- have rolled over, migration 037_audit_hash_chain_backfill will backfill
-- prev_hash/row_hash for pre-036 rows (walking them in (executed_at,
-- audit_id) order) and then enforce NOT NULL. That second migration is
-- the zero-downtime switch; this one adds the surface without blocking
-- existing writers.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 036.6 Tamper-evidence guard (advisory-level, not DDL).
--
-- The existing migration pipeline (src/migrate.ts line ~1195) already
-- revokes UPDATE and DELETE on action_audit_log. Migration 036 does not
-- change that. The hash chain is a second independent layer: even if a
-- superuser bypasses the REVOKE, any mutation will break the forward
-- walk.
-- ---------------------------------------------------------------------------
