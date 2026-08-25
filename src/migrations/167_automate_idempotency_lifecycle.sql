-- P2-8: idempotency record lifecycle.
--
-- automation_idempotency rows expire logically after 24h but were never
-- removed, and plain INSERTs conflicted on the primary key when an expired
-- row still occupied the (tenant_id, owner_user_id, idempotency_key) slot.
-- The repository now uses INSERT ... ON CONFLICT DO UPDATE to atomically
-- replace expired rows. This migration adds an index on expires_at so the
-- periodic cleanup job can delete expired rows without a full table scan.

CREATE INDEX IF NOT EXISTS automation_idempotency_expires_at_idx
  ON automation_idempotency (expires_at);
