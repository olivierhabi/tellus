DROP INDEX IF EXISTS jemma_functions_publish_idempotency_uq;
DROP INDEX IF EXISTS function_publish_request_retry_idx;

ALTER TABLE function_publish_request
  DROP COLUMN IF EXISTS retry_of_run_rid;

DROP INDEX IF EXISTS function_publish_request_release_idx;

-- This intentionally fails if multiple attempts now exist for one release;
-- operators must archive duplicate attempt rows before rolling back because
-- silently deleting run history would be destructive.
CREATE UNIQUE INDEX function_publish_request_release_uq
  ON function_publish_request(repository_rid, branch, semver);
