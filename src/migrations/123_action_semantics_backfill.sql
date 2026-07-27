-- ---------------------------------------------------------------------------
-- Migration 123 — Stage C: Backfill semantics columns to non-null values.
--
-- Existing v1 rows have NULL semantics_version / execution_mode / delete_policy
-- (added nullable in migration 121). Backfill them to the canonical version-1
-- defaults so the Stage D constraint promotion (migration 124) can set NOT NULL.
--
-- Bounded batches for action_type (the only table that could be large); the
-- audit table is bounded by recent executions and backfilled in one statement.
-- Idempotent (only touches NULL rows). Safe to re-run.
-- ---------------------------------------------------------------------------

-- action_type: bounded backfill in 5000-row batches until no NULLs remain.
DO $$
DECLARE
  affected int := 1;
BEGIN
  WHILE affected > 0 LOOP
    UPDATE action_type
       SET semantics_version = 1,
           execution_mode = 'declarative',
           delete_policy = 'legacy_unchecked'
     WHERE ctid IN (
       SELECT ctid FROM action_type
        WHERE semantics_version IS NULL
        LIMIT 5000
     );
    GET DIAGNOSTICS affected = ROW_COUNT;
  END LOOP;
END $$;

-- action_audit_log: one bounded pass (audit rows are bounded by retention).
UPDATE action_audit_log
   SET semantics_version = COALESCE(semantics_version, 1),
       execution_mode = COALESCE(execution_mode, 'declarative')
 WHERE semantics_version IS NULL OR execution_mode IS NULL;

-- Verify no NULLs remain (loud failure if backfill is incomplete).
DO $$
DECLARE
  null_at int;
  null_al int;
BEGIN
  SELECT COUNT(*) INTO null_at FROM action_type
   WHERE semantics_version IS NULL OR execution_mode IS NULL OR delete_policy IS NULL;
  SELECT COUNT(*) INTO null_al FROM action_audit_log
   WHERE semantics_version IS NULL OR execution_mode IS NULL;
  IF null_at > 0 OR null_al > 0 THEN
    RAISE EXCEPTION 'semantics backfill incomplete: action_type NULLs=%, action_audit_log NULLs=%', null_at, null_al;
  END IF;
END $$;
