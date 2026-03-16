import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE TABLE refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id)`);
  await knex.raw(`CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash)`);

  // Add FK constraint from projects.owner_id to users.id
  await knex.raw(`ALTER TABLE projects ADD CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES users(id)`);

  // updated_at trigger for users
  await knex.raw(`
    CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS fk_projects_owner`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_users_updated_at ON users`);
  await knex.raw(`DROP TABLE IF EXISTS refresh_tokens CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS users CASCADE`);
}
