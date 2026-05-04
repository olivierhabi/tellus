-- Migration 057 — B7 JobSpec Publisher.
--
-- One JobSpec row per (output_dataset_rid, branch). Cross-repo collision is
-- detected by the PRIMARY KEY: the second writer attempting to publish for an
-- already-owned (output, branch) tuple gets a 23505 → JobSpec:OutputAlreadyOwned.

CREATE TABLE job_spec (
  output_dataset_rid TEXT NOT NULL,
  branch             TEXT NOT NULL,
  repository_rid     TEXT NOT NULL,
  commit_sha         TEXT NOT NULL,
  source_path        TEXT NOT NULL,
  entry_point        TEXT NOT NULL,
  inputs             JSONB NOT NULL,
  parameters         JSONB NOT NULL DEFAULT '{}'::jsonb,
  compute_profile    TEXT NOT NULL DEFAULT 'default',
  published_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resource_version   BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT job_spec_pk PRIMARY KEY (output_dataset_rid, branch),
  CONSTRAINT job_spec_commit_sha_chk CHECK (commit_sha ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT job_spec_branch_len_chk CHECK (length(branch) >= 1 AND length(branch) <= 255),
  CONSTRAINT job_spec_resource_version_chk CHECK (resource_version >= 1)
);

CREATE INDEX job_spec_repo_branch_idx ON job_spec (repository_rid, branch);
CREATE INDEX job_spec_branch_idx ON job_spec (branch);
