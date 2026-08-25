-- ---------------------------------------------------------------------------
-- Migration 133 — Notification Inbox (Phase 6.4)
--
-- The InApp notification provider needs a per-user inbox table so phase 5
-- recipients with `principal=com.cy.local` resolve to a real user UUID and
-- have a queryable, persistent, mark-read surface.
--
-- Schema:
--   * `notification_inbox` — one row per (recipient_user_id, notification).
--     recipient_user_id is FK to the `users(id)` table (the canonical
--     uuid_keyed principal identifier — populated by the principal
--     resolver in `securityContext.ts`).
--   * `template_id` — the originating notification-template identifier.
--   * `template_parameters` — the per-recipient payload (rendered subject
--     + body at the FE inbox reader).
--   * `action_type_api_name`, `execution_id`, `ontology_id` —
--     provenance metadata so the inbox row can deep-link to the action's
--     audit row + the originating action type's editor.
--   * `read_at` — NULL until the user marks the row read.
--   * `created_at` — for chronological listing.
--
-- Backward-compatible: additive CREATE TABLE; no rows reference back to a
-- pre-migration state. Existing side-effect job rows that have already
-- been delivered through the Phase 5 stub do NOT get backfilled into
-- `notification_inbox` — that would mean writing recipients for the
-- stand-in `__unresolved__` principal stub from the recipient data filter.
-- The In-app provider is the ONLY one to populate this table going forward.
--
-- Indexing:
--   * `(recipient_user_id, created_at DESC)` — the per-user inbox reader.
--   * `(recipient_user_id, read_at)` — partial index on unread for fast
--     "N unread" badge counts.
--   * `(execution_id)` — for the audit-trace cross-link.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_inbox (
  notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL,
  template_id TEXT NOT NULL,
  template_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  channel TEXT NOT NULL DEFAULT 'in_app',
  action_type_api_name TEXT,
  execution_id TEXT,
  ontology_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT notification_inbox_channel_valid CHECK (channel IN ('in_app', 'email', 'slack_compatible'))
);

CREATE INDEX IF NOT EXISTS idx_notification_inbox_user_created
  ON notification_inbox (recipient_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_inbox_user_unread
  ON notification_inbox (recipient_user_id, created_at)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_inbox_execution
  ON notification_inbox (execution_id)
  WHERE execution_id IS NOT NULL;

COMMENT ON TABLE notification_inbox IS
  'Per-user notification inbox. Populated by the InApp/Email/Slack NotificationProvider''s send path on successful delivery.';
COMMENT ON COLUMN notification_inbox.recipient_user_id IS
  'users.id FK (the canonical UUID for the recipient resolved by the notification recipient data filter — never the raw principal string).';
COMMENT ON COLUMN notification_inbox.template_id IS
  'The notification template identifier from the spec — used by the FE inbox reader to render the per-template subject/body.';
COMMENT ON COLUMN notification_inbox.template_parameters IS
  'JSON payload of per-recipient merge fields (e.g. {actor, actionTypeApiName, affectedObjects, ...}).';
COMMENT ON COLUMN notification_inbox.read_at IS
  'NULL until the user marks the row read. The partial index idx_notification_inbox_user_unread lets the unread-count query stay sub-millisecond at inbox scale.';
