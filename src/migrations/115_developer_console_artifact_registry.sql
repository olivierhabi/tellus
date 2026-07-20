-- ---------------------------------------------------------------------------
-- Migration 115: immutable Developer Console SDK artifact publication
-- ---------------------------------------------------------------------------

ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS artifact_digest TEXT;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS artifact_object_key TEXT;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS artifact_size_bytes BIGINT;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS artifact_manifest JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE tpa_sdk_versions
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tpa_sdk_artifact_digest
  ON tpa_sdk_versions (artifact_digest)
  WHERE artifact_digest IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpa_sdk_artifact_object_key
  ON tpa_sdk_versions (artifact_object_key)
  WHERE artifact_object_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tpa_sdk_package_versions
  ON tpa_sdk_versions (package_name, created_at DESC);

CREATE TABLE IF NOT EXISTS tpa_sdk_build_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL,
  application_id    UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  sdk_version_id    UUID REFERENCES tpa_sdk_versions(id) ON DELETE SET NULL,
  state             TEXT NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued', 'running', 'published', 'failed', 'dead_letter')),
  request_hash      TEXT NOT NULL,
  attempt_count     INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,
  lease_owner       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  error_message     TEXT,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_tpa_sdk_build_jobs_ready
  ON tpa_sdk_build_jobs (state, next_attempt_at)
  WHERE state IN ('queued', 'failed');

COMMENT ON COLUMN tpa_sdk_versions.artifact_digest IS
  'SHA-256 digest of the immutable npm-compatible tarball bytes.';
COMMENT ON COLUMN tpa_sdk_versions.artifact_object_key IS
  'Content-addressed object-storage key; published bytes are never overwritten.';
COMMENT ON COLUMN tpa_sdk_versions.artifact_manifest IS
  'Build provenance, file digests, SBOM summary, and compatibility metadata.';
