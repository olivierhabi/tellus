-- Quiver B1 / G-04 — idempotency record table.
-- Spec: tasks/quiver/contracts.md G-04.
-- Decision: D-2026-05-04 D-09 (Postgres-backed; Redis write-through optional).

CREATE TABLE IF NOT EXISTS quiver_idempotency_record (
  idempotency_key   TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  user_id           TEXT NOT NULL,
  route             TEXT NOT NULL,
  body_sha256       BYTEA NOT NULL,
  response_status   INT  NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body     JSONB NOT NULL,
  response_etag     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (idempotency_key, user_id, route)
);

CREATE INDEX IF NOT EXISTS idx_quiver_idempotency_expires
  ON quiver_idempotency_record (expires_at);
