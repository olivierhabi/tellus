import { Knex } from 'knex';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROJECT_ID = '660e8400-e29b-41d4-a716-446655440001';
const ROOT_FOLDER_ID = '770e8400-e29b-41d4-a716-446655440002';

export async function seed(knex: Knex): Promise<void> {
  await knex.raw(
    `INSERT INTO projects (id, name, description, owner_id, default_role) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    [PROJECT_ID, 'Learning (testuser)', 'Palantir Foundry learning project for the speedrun course', TEST_USER_ID, 'viewer']
  );

  await knex.raw(
    `INSERT INTO folders (id, name, parent_folder_id, project_id) VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING`,
    [ROOT_FOLDER_ID, 'Speedrun: Your First E2E Workflow', PROJECT_ID]
  );
}
