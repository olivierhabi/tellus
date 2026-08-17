-- ---------------------------------------------------------------------------
-- Migration 114: Developer Console — long-lived scoped tokens (Sharing & tokens)
-- See tellus-fe/docs/developer-console/PAGE_PARITY_GAP_ANALYSIS.md §5 (S1)
-- and BACKEND_PALANTIR_PARITY.md §3 (tokens surface).
--
-- Stores only a SHA-256 hash of each minted token plus product metadata; the
-- plaintext token is returned exactly once on POST /tokens. Scope preview +
-- lastUsedAt are surfaced for the Sharing & tokens management UI.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tpa_long_lived_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  UUID NOT NULL REFERENCES third_party_applications(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- SHA-256 hash of the plaintext token (never store the secret itself).
  token_hash      TEXT NOT NULL,
  -- First 8 chars of the plaintext token, shown as a fingerprint once.
  token_prefix    TEXT NOT NULL DEFAULT '',
  scopes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at      TIMESTAMPTZ NULL,
  last_used_at    TIMESTAMPTZ NULL,
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ NULL,
  revoked_by      TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_tpa_tokens_app
  ON tpa_long_lived_tokens (application_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tpa_tokens_hash
  ON tpa_long_lived_tokens (token_hash);

COMMENT ON TABLE tpa_long_lived_tokens IS
  'Long-lived scoped tokens minted per third-party-application (Sharing & tokens).';
