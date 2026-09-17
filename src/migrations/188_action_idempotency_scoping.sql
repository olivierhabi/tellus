-- ---------------------------------------------------------------------------
-- Migration 188 — Action idempotency scoping (principal + request hash)
--
-- Closes a cross-user replay hole in the action idempotency cache
-- (idempotency_key table): rows were keyed by idempotency_key ALONE, so two
-- users reusing the same key would replay each other's cached result — user
-- B would receive user A's action result and B's own mutation would be
-- silently suppressed.
--
-- Design (mirrors 059 workshop_idempotency_record and 050 code_repos):
--   * principal    — the authenticated caller (Keycloak subject / shadow
--                    user id, "system" for server-internal executions)
--   * request_hash — sha256 of the canonical request (shared encoder with
--                    code-repos idempotency + audit log)
--   * Primary key moves from (idempotency_key) to
--                    (idempotency_key, principal) so the SAME key may
--                    legitimately coexist for different callers, each with
--                    their own cached outcome.
-- Replay rule enforced in src/actions/idempotency.ts:
--   same key + same principal + same hash → replay; same key + same
--   principal + different hash → 409 IdempotencyConflict; different
--   principal → invisible (normal execution, own scope).
--
-- Pre-migration rows are unscoped (no principal). They are EAGERLY EXPIRED
-- and then deleted: a cached row written before scoping must never replay
-- for anyone, and the composite primary key cannot carry NULL principals.
-- These are 24h-TTL cache rows, so deletion loses no durable data.
-- ---------------------------------------------------------------------------

ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS principal TEXT;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS request_hash TEXT;

-- Eager expiry of every unscoped (pre-migration) row, then removal.
UPDATE idempotency_key SET expires_at = now() WHERE principal IS NULL;
DELETE FROM idempotency_key WHERE principal IS NULL;

-- Swap the primary key to (idempotency_key, principal). Guarded so a fresh
-- database whose base schema (migrate.ts TABLE 12) already creates the
-- scoped shape re-applies this migration cleanly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'idempotency_key_pkey' AND conrelid = 'idempotency_key'::regclass
  ) THEN
    ALTER TABLE idempotency_key DROP CONSTRAINT idempotency_key_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'idempotency_key_scoped_pkey' AND conrelid = 'idempotency_key'::regclass
  ) THEN
    ALTER TABLE idempotency_key ALTER COLUMN principal SET NOT NULL;
    ALTER TABLE idempotency_key
      ADD CONSTRAINT idempotency_key_scoped_pkey
      PRIMARY KEY (idempotency_key, principal);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_idempotency_key_principal
  ON idempotency_key (principal);

COMMENT ON COLUMN idempotency_key.principal IS
  'Authenticated caller who owns this cached result (Keycloak subject / shadow user id, "system" for server-internal executions). Replay only ever happens inside the same principal scope.';
COMMENT ON COLUMN idempotency_key.request_hash IS
  'sha256 of the canonical request (method + path + body). Same key + same principal + different hash = 409 IdempotencyConflict.';
COMMENT ON TABLE idempotency_key IS
  'Stores cached action execution results keyed by (client-provided idempotency key, principal). Prevents duplicate action execution on client retries; keys expire after 24 hours. Cross-principal replay is impossible by construction (migration 188).';
