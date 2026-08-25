-- Revert P1-3: remove the 'cancelling' status from the trigger-event check.
--
-- Safe only when no row carries status='cancelling' (the application must
-- drain or finalize such rows before applying the down migration).

DELETE FROM automation_trigger_event WHERE status = 'cancelling';

ALTER TABLE automation_trigger_event
  DROP CONSTRAINT automation_trigger_event_status_check;

ALTER TABLE automation_trigger_event
  ADD CONSTRAINT automation_trigger_event_status_check
  CHECK (status IN (
    'queued', 'running',
    'succeeded', 'partially_failed', 'failed', 'cancelled', 'skipped'
  ));
