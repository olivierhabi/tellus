-- Workshop B01/G-03 — idempotency_record table.
-- Spec: §0.3 Idempotency. Stores (idempotency_key, user_id, route, sha256(body)) for 24h.
-- Decision: D-2026-05-03 D-09.

CREATE TABLE IF NOT EXISTS workshop_idempotency_record (
  idempotency_key TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  route           TEXT NOT NULL,
  body_sha256     BYTEA NOT NULL,
  response_status INT  NOT NULL,
  response_body   JSONB NOT NULL,
  response_etag   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (idempotency_key, user_id, route)
);

CREATE INDEX IF NOT EXISTS idx_workshop_idempotency_expires
  ON workshop_idempotency_record(expires_at);
