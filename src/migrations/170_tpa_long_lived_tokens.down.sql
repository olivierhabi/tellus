BEGIN;
DROP INDEX IF EXISTS idx_tpa_tokens_hash;
DROP INDEX IF EXISTS idx_tpa_tokens_app;
DROP TABLE IF EXISTS tpa_long_lived_tokens;
COMMIT;
