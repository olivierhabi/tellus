-- Gap 2: durable/resumable build scheduling.
-- A build can now be retried (a fresh execution of the same repo+branch+commit),
-- and retry attempts are bounded + linked to the original build.
--   retry_of      -> the original build rid this retry re-runs (NULL for originals)
--   retry_count   -> how many times this build has been retried (0 for an original)
--   max_retries   -> per-build cap; POST .../retry is rejected (429) at the cap
ALTER TABLE transform_build ADD COLUMN IF NOT EXISTS retry_of TEXT;
ALTER TABLE transform_build ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transform_build ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
-- Idempotency: a retry keyed by the same Idempotency-Key returns the existing build.
ALTER TABLE transform_build ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS transform_build_idempotency_key_uq
  ON transform_build (idempotency_key) WHERE idempotency_key IS NOT NULL;
