import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await knex.raw(`ALTER TABLE folders ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await knex.raw(`ALTER TABLE datasets ADD COLUMN IF NOT EXISTS search_vector TSVECTOR`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_projects_search ON projects USING GIN(search_vector)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_folders_search ON folders USING GIN(search_vector)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_datasets_search ON datasets USING GIN(search_vector)`);
  await knex.raw(`CREATE OR REPLACE FUNCTION update_project_search_vector() RETURNS TRIGGER AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.name, '') || ' ' || coalesce(NEW.description, '')); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE OR REPLACE FUNCTION update_folder_search_vector() RETURNS TRIGGER AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.name, '')); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE OR REPLACE FUNCTION update_dataset_search_vector() RETURNS TRIGGER AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.name, '') || ' ' || coalesce(NEW.original_filename, '')); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER trg_projects_search_vector BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_project_search_vector()`);
  await knex.raw(`CREATE TRIGGER trg_folders_search_vector BEFORE INSERT OR UPDATE ON folders FOR EACH ROW EXECUTE FUNCTION update_folder_search_vector()`);
  await knex.raw(`CREATE TRIGGER trg_datasets_search_vector BEFORE INSERT OR UPDATE ON datasets FOR EACH ROW EXECUTE FUNCTION update_dataset_search_vector()`);
  await knex.raw(`UPDATE projects SET search_vector = to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, ''))`);
  await knex.raw(`UPDATE folders SET search_vector = to_tsvector('english', coalesce(name, ''))`);
  await knex.raw(`UPDATE datasets SET search_vector = to_tsvector('english', coalesce(name, '') || ' ' || coalesce(original_filename, ''))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_projects_search_vector ON projects`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_folders_search_vector ON folders`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_datasets_search_vector ON datasets`);
  await knex.raw(`DROP FUNCTION IF EXISTS update_project_search_vector()`);
  await knex.raw(`DROP FUNCTION IF EXISTS update_folder_search_vector()`);
  await knex.raw(`DROP FUNCTION IF EXISTS update_dataset_search_vector()`);
  await knex.raw(`DROP INDEX IF EXISTS idx_projects_search`);
  await knex.raw(`DROP INDEX IF EXISTS idx_folders_search`);
  await knex.raw(`DROP INDEX IF EXISTS idx_datasets_search`);
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS search_vector`);
  await knex.raw(`ALTER TABLE folders DROP COLUMN IF EXISTS search_vector`);
  await knex.raw(`ALTER TABLE datasets DROP COLUMN IF EXISTS search_vector`);
}
