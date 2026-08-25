-- Reverse 123 (backfill). Re-nulls the values is NOT done — backfill is
-- one-way and safe to leave applied. This down-migration is intentionally a
-- no-op: re-nulling semantics_version would break the read-time fallback
-- semantics and risk downgrading v2 rows. Rollback of 123 is achieved by
-- dropping the columns in the 121 down migration if a full rollback is
-- required (see rollback policy — do not silently downgrade v2).
SELECT 1;
