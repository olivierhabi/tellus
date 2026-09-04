-- ---------------------------------------------------------------------------
-- Migration 187 — Workshop Comments (Foundry Comments widget parity)
--
-- Backs the Workshop Comments widget (docs: workshop/widgets-comments):
--
--   * Comments attach to a PARENT OBJECT, identified by
--     (object_type_api_name, primary_key). They follow the parent object's
--     permissions — the service layer re-checks parent readability through
--     the same security-filtered object fetch the search routes use.
--   * A user may delete their own comments (soft delete — the Action Log
--     remains the only append-only surface).
--   * References (object mentions / user mentions) are stored as structured
--     tokens next to the body so the FE can render interactive chips
--     without re-parsing.
--   * Comment-level attachments reference `ri.attachments.*` rids uploaded
--     through the existing attachment service (200 MB cap enforced there).
--   * Thread subscriptions drive the default-notification behavior:
--     commenting subscribes the author; mentioning a user subscribes them;
--     future comments notify all other subscribers (in-app inbox rows).
--
-- Backward-compatible: additive CREATE TABLE IF NOT EXISTS only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS comment_thread (
  thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ontology_id TEXT,
  object_type_api_name TEXT NOT NULL,
  primary_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comment_thread_object_unique
    UNIQUE (object_type_api_name, primary_key)
);

CREATE INDEX IF NOT EXISTS idx_comment_thread_object
  ON comment_thread (object_type_api_name, primary_key);

CREATE TABLE IF NOT EXISTS object_comment (
  comment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES comment_thread(thread_id) ON DELETE CASCADE,
  author_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Structured reference tokens:
  --   [{"kind":"object","objectTypeApiName","primaryKey","displayTitle"} |
  --    {"kind":"user","userId","displayName"}]
  "references" JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Attachment rids uploaded via /api/v2/ontologies/attachments/upload.
  attachment_rids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_object_comment_thread_created
  ON object_comment (thread_id, created_at);

CREATE TABLE IF NOT EXISTS comment_thread_subscription (
  thread_id UUID NOT NULL REFERENCES comment_thread(thread_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT comment_thread_subscription_pk PRIMARY KEY (thread_id, user_id)
);

COMMENT ON TABLE comment_thread IS
  'Workshop Comments widget thread: one row per (object_type_api_name, primary_key) parent object. Comments follow the parent object permissions (re-checked per request through the security-filtered object fetch).';
COMMENT ON TABLE object_comment IS
  'A single comment. Soft-deleted via deleted_at; the comment service is the source of truth (mirrored Action Log rows never drive edit/delete).';
COMMENT ON TABLE comment_thread_subscription IS
  'Default-notification subscription: commenting subscribes the author, mentioning subscribes the mentioned user; future comments notify all other subscribers.';
