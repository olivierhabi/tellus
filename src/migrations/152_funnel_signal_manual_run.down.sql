-- Down migration for 152_funnel_signal_manual_run.sql
ALTER TABLE funnel_signal
    DROP CONSTRAINT IF EXISTS funnel_signal_signal_type_check;
ALTER TABLE funnel_signal
    ADD CONSTRAINT funnel_signal_signal_type_check
    CHECK (signal_type IN (
      'sourceTransactionCommitted',
      'editBatchPending',
      'schemaChanged',
      'pipelineDeployCompleted'
    ));
