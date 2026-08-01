-- ---------------------------------------------------------------------------
-- Task PB-B8 follow-fnl-h3 — pipelineDeployCompleted signal type.
--
-- The spec's FNL-H3 item adds a dedicated Funnel signal a Pipeline
-- Builder deploy fires alongside the generic `sourceTransactionCommitted`.
-- Consumers that want pipeline-event semantics subscribe to this
-- instead of inferring from source transactions.
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
-- NB: 152_funnel_signal_manual_run.sql exists because the ORIGINAL body of this
-- migration accidentally DROPPED 'manualRun' (added by 018): the widened list
-- here includes it, and 152 additionally widens any schema that received the
-- historical (erroneous) form.
