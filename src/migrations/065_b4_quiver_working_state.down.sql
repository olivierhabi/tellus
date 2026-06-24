DROP FUNCTION IF EXISTS quiver_purge_expired_working_states();
DROP INDEX IF EXISTS idx_quiver_working_state_by_user;
DROP INDEX IF EXISTS idx_quiver_working_state_expires;
DROP TABLE IF EXISTS quiver_working_state;
