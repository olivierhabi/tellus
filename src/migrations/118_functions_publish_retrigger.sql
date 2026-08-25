-- Allow a durable functions-publish release to have multiple execution
-- attempts while retaining every attempt's run, stages, and logs.

DROP INDEX IF EXISTS function_publish_request_release_uq;

CREATE INDEX IF NOT EXISTS function_publish_request_release_idx
  ON function_publish_request(repository_rid, branch, semver, created_at DESC);

ALTER TABLE function_publish_request
  ADD COLUMN IF NOT EXISTS retry_of_run_rid TEXT
    REFERENCES jemma_run(rid) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS function_publish_request_retry_idx
  ON function_publish_request(retry_of_run_rid, created_at DESC)
  WHERE retry_of_run_rid IS NOT NULL;

-- Idempotency is scoped to a principal for functions-publish mutations. This
-- closes the race where two browser retries with the same key could otherwise
-- create two queued attempts before either transaction becomes visible.
CREATE UNIQUE INDEX IF NOT EXISTS jemma_functions_publish_idempotency_uq
  ON jemma_run(triggered_by, idempotency_key)
  WHERE job_name = 'functions-publish' AND idempotency_key IS NOT NULL;
