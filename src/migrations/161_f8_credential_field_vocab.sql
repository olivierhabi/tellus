-- F8 — relax the connectivity_credentials.field CHECK constraint to admit
-- the named per-secret storage fields for REST-API sources
-- (api_key, bearer_token, basic_auth, custom_header). The original CHECK
-- (migration 076) only allowed ('password','client_key','service_account_json',
-- 'token','other'); REST secrets were bundled into 'other' as a JSON blob.
-- Drop the old constraint and add a new one with the extended vocabulary.
-- The legacy 'other' row is retained for back-compat reads.

ALTER TABLE connectivity_credentials
  DROP CONSTRAINT IF EXISTS connectivity_credentials_field_check;

ALTER TABLE connectivity_credentials
  ADD CONSTRAINT connectivity_credentials_field_check
  CHECK (field IN (
    'password', 'client_key', 'service_account_json', 'token', 'other',
    'api_key', 'bearer_token', 'basic_auth', 'custom_header'
  ));
