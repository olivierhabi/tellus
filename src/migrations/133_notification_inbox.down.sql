-- Down migration for 133_notification_inbox.

DROP INDEX IF EXISTS idx_notification_inbox_user_created;
DROP INDEX IF EXISTS idx_notification_inbox_user_unread;
DROP INDEX IF EXISTS idx_notification_inbox_execution;
DROP TABLE IF EXISTS notification_inbox;
