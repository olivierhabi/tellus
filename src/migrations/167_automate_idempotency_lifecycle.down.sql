-- Revert P2-8: drop the expires_at index added for the cleanup job.

DROP INDEX IF EXISTS automation_idempotency_expires_at_idx;
