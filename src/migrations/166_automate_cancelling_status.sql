-- P1-3: atomic cancellation with worker claiming.
--
-- A trigger whose effects are already in flight (claimed/running) cannot be
-- flipped straight to 'cancelled' — the canonical runtime cannot interrupt a
-- running side effect, and a 'cancelled' trigger with an executing effect is
-- a corrupt state. Such a trigger transitions to the new 'cancelling' state
-- instead; finalization flips it to 'cancelled' once the in-flight effect
-- settles. This migration extends the trigger-event status check constraint
-- to permit 'cancelling'. No data backfill is required; existing rows are
-- unaffected because none carry the new status.

ALTER TABLE automation_trigger_event
  DROP CONSTRAINT automation_trigger_event_status_check;

ALTER TABLE automation_trigger_event
  ADD CONSTRAINT automation_trigger_event_status_check
  CHECK (status IN (
    'queued', 'running', 'cancelling',
    'succeeded', 'partially_failed', 'failed', 'cancelled', 'skipped'
  ));
