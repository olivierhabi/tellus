-- B2 — credential rotation policy column.
--
-- The rotation worker (src/services/connectivity/credentials/rotation.worker.ts)
-- pre-emptively re-wraps credentials whose age exceeds a per-credential
-- `rotate_after_days` policy (minus ROTATION_LEEWAY_DAYS). The original
-- 076_b2_connectivity_credentials migration created the table without this
-- policy column, so the worker's 5-minute sweep failed every tick with
-- `column "rotate_after_days" does not exist` (SQLSTATE 42703).
--
-- NULL means "never auto-rotate" — the worker's WHERE clause requires
-- `rotate_after_days IS NOT NULL`, so adding the column nullable is fully
-- backward compatible: existing credentials keep their current (no-rotation)
-- behaviour until an operator opts a row into a rotation cadence.
ALTER TABLE connectivity_credentials
  ADD COLUMN IF NOT EXISTS rotate_after_days INTEGER
    CHECK (rotate_after_days IS NULL OR rotate_after_days > 0);
