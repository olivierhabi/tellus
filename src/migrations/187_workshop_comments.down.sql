-- Down migration for 187_workshop_comments.

DROP TABLE IF EXISTS comment_thread_subscription;
DROP TABLE IF EXISTS object_comment;
DROP TABLE IF EXISTS comment_thread;
