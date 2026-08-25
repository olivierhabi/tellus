-- ---------------------------------------------------------------------------
-- Phase 2 (OSSv2/OMS parity) — stable object RIDs
--
-- Every object instance gets a stable resource identifier that survives
-- edits, reindexes and branch reads. The exact Palantir object-RID prefix
-- is not publicly documented, so we use a stable Tellus namespace:
--
--     ri.tellus.main.object.<uuid>
--
-- Idempotent: safe to run against a database that already has the column.
-- Bounded backfill: UPDATE ... WHERE rid IS NULL is a no-op on re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE object_instances
    ADD COLUMN IF NOT EXISTS rid TEXT;

-- New rows are safe immediately, including legacy INSERT paths that do
-- not explicitly provide a RID. This metadata-only default does not
-- rewrite the populated table.
ALTER TABLE object_instances
    ALTER COLUMN rid
    SET DEFAULT ('ri.tellus.main.object.' || gen_random_uuid());

-- Existing rows are backfilled by:
--
--   npm run migrate:backfill-object-rids
--
-- The repository migration gate wraps every .sql file in ONE
-- transaction, so a SQL DO-loop cannot provide real batching. The
-- client-side backfill commits each small UPDATE independently, uses an
-- advisory lock, and is safely resumable after interruption.

-- The final partial unique index is also created by the client-side
-- backfill command, using CREATE INDEX CONCURRENTLY. Building it here
-- would run inside the migration gate's transaction and take a
-- long-lived ACCESS SHARE lock on large deployments. Keeping the
-- online index build in the resumable operator command makes startup
-- bounded:
--
--   npm run migrate:backfill-object-rids
