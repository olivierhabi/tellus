-- ---------------------------------------------------------------------------
-- Down migration 036: revert audit hash chain.
--
-- Validated against a restored snapshot by the Block B rollback rehearsal
-- procedure documented in docs/remediation/block-b-rollback.md. This
-- down-migration is RISKY: if any audit row has been written after the up
-- migration and the Action pipeline has been upgraded to require
-- prev_hash/row_hash, running this down-migration will leave the
-- application code asserting invariants that no longer hold in the schema.
-- The safe rollback path is:
--
--   1. Deploy application code that treats prev_hash/row_hash as optional
--      (the Block A / pre-B state).
--   2. Wait for all in-flight transactions to commit.
--   3. Run this down migration.
--
-- Step 1 is a feature flag on `src/services/audit/hashChain.ts`
-- (ENFORCE_AUDIT_HASH_CHAIN env var). When the flag is off, the audit
-- service falls back to pre-036 behaviour (no hash chain, no head
-- pointer). The flag is the first hop of the runbook.
-- ---------------------------------------------------------------------------

-- 036.4r — drop the verifier-support indices.
DROP INDEX IF EXISTS idx_audit_chain_prev;
DROP INDEX IF EXISTS idx_audit_chain_walk;

-- 036.3r — remove the genesis row.
-- We do NOT remove historical audit rows; we only remove the synthetic
-- genesis anchor. Audit rows written after the up-migration will retain
-- their prev_hash/row_hash values until the columns are dropped in the
-- next step; those values become orphan strings, which is acceptable —
-- the forward walk verifier is what interprets them, and the verifier is
-- disabled when the columns are gone.
DELETE FROM action_audit_log
 WHERE audit_id = '00000000-0000-0000-0000-000000000000'::uuid
   AND action_type_api_name = '__tellus_audit_genesis__';

-- 036.2r — drop the head pointer.
DROP TABLE IF EXISTS audit_hash_head;

-- 036.1r — drop the hash-chain columns.
ALTER TABLE action_audit_log DROP COLUMN IF EXISTS row_hash;
ALTER TABLE action_audit_log DROP COLUMN IF EXISTS prev_hash;

-- pgcrypto was created idempotently by 036 but may have been required by
-- other migrations (e.g. digest() for password hashing elsewhere). We
-- intentionally do NOT drop the extension here — that is the
-- responsibility of whatever migration introduced the first digest()
-- call, and undoing it could cascade into unrelated subsystems.
