-- F8 — revert the credential-field vocabulary to the original set.
ALTER TABLE connectivity_credentials
  DROP CONSTRAINT IF EXISTS connectivity_credentials_field_check;

ALTER TABLE connectivity_credentials
  ADD CONSTRAINT connectivity_credentials_field_check
  CHECK (field IN ('password', 'client_key', 'service_account_json', 'token', 'other'));
