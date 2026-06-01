-- B1 — connectivity_outbox (Compass two-phase commit)
-- Pattern: write outbox row in same transaction as connections insert; a poller
-- claims unclaimed rows (FOR UPDATE SKIP LOCKED) and forwards to Compass.
-- Compass.registerResource is idempotent on (resourceRid, folderRid), so re-delivery
-- after worker crash is safe.

CREATE TABLE IF NOT EXISTS connectivity_outbox (
  id                BIGSERIAL PRIMARY KEY,
  connection_rid    TEXT NOT NULL,
  folder_rid        TEXT NOT NULL,
  operation         TEXT NOT NULL CHECK (operation IN ('registerResource', 'unregisterResource', 'renameResource')),
  payload           JSONB NOT NULL,
  enqueued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at        TIMESTAMPTZ,
  claimed_by        TEXT,
  delivered_at      TIMESTAMPTZ,
  last_error        TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS connectivity_outbox_unclaimed
  ON connectivity_outbox (enqueued_at)
  WHERE delivered_at IS NULL AND claimed_at IS NULL;

CREATE INDEX IF NOT EXISTS connectivity_outbox_stale_claims
  ON connectivity_outbox (claimed_at)
  WHERE delivered_at IS NULL AND claimed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS connectivity_outbox_by_rid
  ON connectivity_outbox (connection_rid, enqueued_at);
