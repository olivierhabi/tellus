import { Knex } from 'knex';

/**
 * Personal Access Tokens — ontology/tellus-auth.md Task 9.
 *
 * Mirrors Palantir's PAT model: user-generated bearer credentials with a
 * user-specified lifetime, hashed at rest, inherit permissions at request
 * time, and cannot mint other tokens. Deactivation cascades by revoking
 * the user's PATs along with their session tokens.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE personal_access_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      keycloak_sub VARCHAR(255),
      name VARCHAR(255) NOT NULL,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      token_prefix VARCHAR(32) NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      CHECK (expires_at > created_at)
    )
  `);
  await knex.raw(`CREATE INDEX idx_pat_user ON personal_access_tokens(user_id)`);
  await knex.raw(`CREATE INDEX idx_pat_hash ON personal_access_tokens(token_hash)`);
  await knex.raw(`CREATE INDEX idx_pat_sub ON personal_access_tokens(keycloak_sub)`);

  // Session-scope revocation registry (jti blacklist). Row = revoked JWT id.
  await knex.raw(`
    CREATE TABLE auth_revoked_tokens (
      jti VARCHAR(128) PRIMARY KEY,
      user_id UUID,
      keycloak_sub VARCHAR(255),
      revoked_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await knex.raw(`CREATE INDEX idx_revoked_expires ON auth_revoked_tokens(expires_at)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS auth_revoked_tokens`);
  await knex.raw(`DROP TABLE IF EXISTS personal_access_tokens`);
}
