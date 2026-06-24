-- Reverses migration 033. Drop in reverse-dependency order. No FKs
-- between the two B10 tables; the order is therefore arbitrary, but we
-- drop subscription first to mirror creation order.
DROP INDEX IF EXISTS stemma_subscription_event_types_gin_idx;
DROP INDEX IF EXISTS stemma_subscription_active_idx;
DROP TABLE IF EXISTS stemma_subscription;

DROP INDEX IF EXISTS stemma_event_type_time_idx;
DROP INDEX IF EXISTS stemma_event_repo_time_idx;
DROP TABLE IF EXISTS stemma_event;
