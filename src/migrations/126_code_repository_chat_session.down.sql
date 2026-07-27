-- Down migration for 126_code_repository_chat_session.sql.
-- Drops the chat-message child first (cascade FK), then the session parent.

DROP INDEX IF EXISTS code_repository_chat_message_session_seq;
DROP TABLE IF EXISTS code_repository_chat_message;
DROP INDEX IF EXISTS code_repository_chat_session_lookup;
DROP TABLE IF EXISTS code_repository_chat_session;
