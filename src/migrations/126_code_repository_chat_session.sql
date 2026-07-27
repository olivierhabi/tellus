-- Migration 126 — code_repository_chat_session + code_repository_chat_message.
--
-- Per-(principal_sub, repository_rid) persistent chat-session store for the
-- Code Assistant panel mounted inside code-repositories. Sessions are PRIVATE
-- to the user (`principal_sub`) and cascade-deleted with the parent repo.
--
-- Mirrors `code_repository_draft` (migration 104) for the (principal_sub UUID,
-- repository_rid TEXT FK ON DELETE CASCADE) shape, plus an ordered 1:N child
-- `code_repository_chat_message` table that stores the runtime chat
-- transcript.  Messages carry a JSONB `metadata` blob so the panel can round-trip
-- UI-only affordances (tool invocation chain, Gemini "thinking" trace, inline
-- code-change proposals) that are NOT part of the agent's `history` payload.
--
-- REST surface (admin/routes.ts, mounted under /api/v1/code-repositories):
--   GET    /:rid/chat-sessions              — list the caller's sessions (no
--                                             message bodies; newest first).
--   POST   /:rid/chat-sessions              — create a session + initial
--                                             messages (atomic, Idempotency-Key).
--   GET    /:rid/chat-sessions/:sessionId   — fetch one session WITH messages.
--   PUT    /:rid/chat-sessions/:sessionId   — update title/metadata and/or
--                                             REPLACE the message set atomically.
--   DELETE /:rid/chat-sessions/:sessionId   — delete one session (+ messages).

CREATE TABLE IF NOT EXISTS code_repository_chat_session (
  session_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_sub         UUID        NOT NULL,
  repository_rid        TEXT        NOT NULL REFERENCES code_repository(rid) ON DELETE CASCADE,
  -- 'typescript-v2' | 'python-transform' — the agent ingress path this
  -- session was started under; a Python transform session is never re-bound
  -- to the TS agent on load (the host page already chooses the correct path
  -- from the repo `templateId`, but we persist it so the restored session's
  -- origin is unambiguous in the UI / audits).
  assistant_path        TEXT        NOT NULL CHECK (assistant_path IN ('typescript-v2','python-transform')),
  title                 TEXT        NOT NULL DEFAULT 'Untitled session',
  branch                TEXT,
  last_active_file_path TEXT,
  model_id              TEXT,
  mode                  TEXT        CHECK (mode IS NULL OR mode IN ('generate','review','modify')),
  message_count         INTEGER     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_repository_chat_session_lookup
  ON code_repository_chat_session (principal_sub, repository_rid, updated_at DESC);

CREATE TABLE IF NOT EXISTS code_repository_chat_message (
  message_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID        NOT NULL REFERENCES code_repository_chat_session(session_id) ON DELETE CASCADE,
  -- 1-based ordinal within the session, INSERT-order. UNIQUE with session_id,
  -- so a replace模式下 delete-all+insert sequence with explicit seq never
  -- races with a concurrent reader (readers see either the old or new set).
  seq           INTEGER     NOT NULL CHECK (seq >= 1),
  role          TEXT        NOT NULL CHECK (role IN ('user','assistant')),
  content       TEXT        NOT NULL,
  -- JSONB metadata blob (~small, ≤ 256 KiB per message). Round-trips the
  -- panel's UI-only extras: { tools?, thinking?, codeChanges?, codeChangeFlow? }.
  -- Stays out of the `content` column (which is plain markdown) so the
  -- agent's `history`-turn builder can ignore it on load.
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_repository_chat_message_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS code_repository_chat_message_session_seq
  ON code_repository_chat_message (session_id, seq);
