import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`CREATE TABLE project_members (project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')), created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (project_id, user_id))`);
  await knex.raw(`CREATE INDEX idx_project_members_user ON project_members(user_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS project_members CASCADE`);
}
