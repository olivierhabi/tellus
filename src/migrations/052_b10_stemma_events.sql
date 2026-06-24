-- ---------------------------------------------------------------------------
-- Migration 033: B10 — Stemma Events / Branch Protection
--
-- Owns:
--   * stemma_event       — append-only event log; cursor-paginated by
--                          (occurred_at, rid). Rows are written by the
--                          post-receive handler (B10-C-03) AND the
--                          PR / merge / tag publishers (when those land).
--   * stemma_subscription — webhook subscriber registry; supports global
--                          + per-repo scope; secret_encrypted is the
--                          encrypted (envelope) form of the HMAC secret.
--
-- The Kafka topic `stemma.refs.updated` is the asynchronous fan-out
-- (B10-C-03 / B10-C-15) and is NOT modelled here — Kafka is the source
-- of truth for at-least-once delivery; the SQL `stemma_event` table is
-- the queryable history that satisfies B10-C-12 (`GET /events`).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 033.1 stemma_event
-- ---------------------------------------------------------------------------
CREATE TABLE stemma_event (
  rid              TEXT        PRIMARY KEY
                                 CHECK (rid ~ '^ri\.([a-z][a-z0-9-]*)\.([a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(.+)$'),
  repository_rid   TEXT        NOT NULL
                                 CHECK (repository_rid ~ '^ri\.([a-z][a-z0-9-]*)\.([a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(.+)$'),
  -- Bounded enum of event types. New types require a migration (no
  -- ALTER TABLE … CHECK rewrite at runtime).
  event_type       TEXT        NOT NULL
                                 CHECK (event_type IN (
                                   'PUSH', 'MERGE', 'TAG',
                                   'PR_OPENED', 'PR_MERGED', 'PR_CLOSED',
                                   'BRANCH_CREATED', 'BRANCH_DELETED'
                                 )),
  -- Optional ref name (NULL for events that aren't ref-scoped).
  ref              TEXT,
  -- Old/new SHA for ref-update events. NULL for non-ref events.
  old_sha          TEXT        CHECK (old_sha IS NULL OR old_sha ~ '^[0-9a-f]{40}$'),
  new_sha          TEXT        CHECK (new_sha IS NULL OR new_sha ~ '^[0-9a-f]{40}$'),
  -- Subject of the event (the principal that caused it). UUID because
  -- Multipass keycloakSub is UUID format.
  principal_sub    UUID,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Free-form structured payload. Capped at 64 KB by the application
  -- layer; the DB enforces only "valid jsonb".
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE stemma_event IS
  'Append-only event log for Code Repos lifecycle events (B10-C-03..12). Cursor-paginated by (occurred_at, rid). 1:1 with Kafka topic stemma.refs.updated for the PUSH event type; PR/MERGE/TAG events are written here by the corresponding service.';

-- B10-C-12 — `GET /events?repositoryRid=&since=&pageSize=&pageToken=`
-- Cursor pagination needs deterministic ordering on (occurred_at, rid)
-- so two events at the same timestamp don't cause a cursor to skip rows.
CREATE INDEX stemma_event_repo_time_idx
  ON stemma_event (repository_rid, occurred_at DESC, rid DESC);

CREATE INDEX stemma_event_type_time_idx
  ON stemma_event (event_type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 033.2 stemma_subscription
-- ---------------------------------------------------------------------------
CREATE TABLE stemma_subscription (
  rid              TEXT        PRIMARY KEY
                                 CHECK (rid ~ '^ri\.([a-z][a-z0-9-]*)\.([a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(.+)$'),
  -- Array of event types this subscriber wants. Empty array is invalid;
  -- enforced via CHECK so a misconfigured row never silently swallows
  -- every event.
  event_types      TEXT[]      NOT NULL CHECK (cardinality(event_types) > 0),
  -- NULL = global (all repos). Otherwise scoped to one repository RID.
  repository_rid   TEXT        CHECK (
                                 repository_rid IS NULL
                                 OR repository_rid ~ '^ri\.([a-z][a-z0-9-]*)\.([a-z0-9-]*)\.([a-z][a-z0-9-]*)\.(.+)$'
                               ),
  -- Where to POST. Constrained to https:// in production by the
  -- application layer; the DB allows http:// too because the existing
  -- dev/test stack uses http for local subscribers.
  target_uri       TEXT        NOT NULL CHECK (length(target_uri) >= 1 AND length(target_uri) <= 2048),
  -- Encrypted form of the HMAC secret. The plaintext is NEVER stored.
  -- Decryption is on hot path before each callback; cipher choice is up
  -- to the application layer (we just store text).
  secret_encrypted TEXT        NOT NULL,
  -- B10 spec edge case: 5 consecutive failures → state = SUSPENDED.
  state            TEXT        NOT NULL CHECK (state IN ('ACTIVE', 'SUSPENDED')) DEFAULT 'ACTIVE',
  consecutive_failures
                   INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE stemma_subscription IS
  'Webhook subscriber registry for Code Repos events (B10-C-11). Secret is stored encrypted; HMAC-SHA256 signature in X-Tellus-Signature on every callback (B10-C-13). 5 consecutive failures auto-suspend.';

-- Lookup index for the fan-out path: "every ACTIVE subscription that
-- wants event_type X for repository_rid Y or globally". Postgres can
-- use the GIN index on event_types for the ANY-match.
CREATE INDEX stemma_subscription_active_idx
  ON stemma_subscription (state, repository_rid)
  WHERE state = 'ACTIVE';

CREATE INDEX stemma_subscription_event_types_gin_idx
  ON stemma_subscription USING GIN (event_types);
