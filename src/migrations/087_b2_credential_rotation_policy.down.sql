-- Reverse of 087_b2_credential_rotation_policy.sql
ALTER TABLE connectivity_credentials
  DROP COLUMN IF EXISTS rotate_after_days;
