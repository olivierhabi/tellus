-- ---------------------------------------------------------------------------
-- Task B3 — Signal idempotency + re-delivery safety.
--
-- Production needs:
--   * Idempotent sendSignal: an action-retry from a flaky client must
--     dedupe on a caller-supplied fingerprint instead of enqueueing
--     two signals that race to drive the pipeline twice.
--   * Re-delivery safety: if the worker picking up a signal dies mid-
--     workflow, claimNextSignal's `consumed_at` write is transactional
--     so SKIP LOCKED releases the row and another worker picks it up.
--     But when a workflow is terminated (TERMINATE_EXISTING), the
--     signal was already consumed and we must re-insert a replacement
--     so the new workflow sees it.
-- ---------------------------------------------------------------------------

-- Deduplication fingerprint — idempotent inserts via ON CONFLICT.
-- Backwards compatible: existing rows keep NULL and are never deduped.
ALTER TABLE funnel_signal
    ADD COLUMN IF NOT EXISTS signal_fingerprint TEXT;

-- Unique constraint is PARTIAL so legacy rows with NULL fingerprints
-- don't fight for the same slot.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_signal_fingerprint_unique
    ON funnel_signal (object_type_api_name, signal_fingerprint)
    WHERE signal_fingerprint IS NOT NULL;

-- Re-delivery trail. When a workflow is terminated before processing a
-- claimed signal, the worker / sweeper re-queues the signal by clearing
-- `consumed_at` and `consumed_by_run_id`, incrementing `redelivery_count`.
-- An audit field for on-call.
ALTER TABLE funnel_signal
    ADD COLUMN IF NOT EXISTS redelivery_count INTEGER NOT NULL DEFAULT 0;
