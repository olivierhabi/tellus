-- Reverse of 120_transform_build_runtime.sql.
-- Drops the runtime column added by the forward migration. Safe because it
-- is IF EXISTS; a no-op if the column was never added.
ALTER TABLE transform_build DROP COLUMN IF EXISTS runtime;
