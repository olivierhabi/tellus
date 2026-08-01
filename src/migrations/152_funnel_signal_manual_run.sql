-- ---------------------------------------------------------------------------
-- 152 — restore manualRun funnel_signal signal type (FUNN-ISO audit).
--
-- BUG: 026_fnl_h3_pipeline_deploy_signal.sql DROPs the 018 widening
-- constraint and re-adds a check WITHOUT 'manualRun'. NOT VALID no longer
-- shields anything: the constraint then REJECTS every new manualRun signal
-- — the exact signal re-index/repair flows emit
-- (scripts/repair-olivierorder.ts, reindex routes, tests).
-- ---------------------------------------------------------------------------

ALTER TABLE funnel_signal
    DROP CONSTRAINT IF EXISTS funnel_signal_signal_type_check;

ALTER TABLE funnel_signal
    ADD CONSTRAINT funnel_signal_signal_type_check
    CHECK (signal_type IN (
      'sourceTransactionCommitted',
      'editBatchPending',
      'schemaChanged',
      'manualRun',
      'pipelineDeployCompleted'
    ));
