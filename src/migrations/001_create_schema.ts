import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS ltree');
  await knex.raw(`CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, description TEXT, owner_id UUID NOT NULL, default_role VARCHAR(50) DEFAULT 'viewer', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), CONSTRAINT uq_projects_owner_name UNIQUE (owner_id, name))`);
  await knex.raw(`CREATE TABLE folders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, parent_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL, project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path LTREE NOT NULL, depth INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), CONSTRAINT uq_folders_parent_name UNIQUE (project_id, parent_folder_id, name), CONSTRAINT chk_folders_depth CHECK (depth = nlevel(path) - 1))`);
  await knex.raw(`CREATE OR REPLACE FUNCTION update_folder_path() RETURNS TRIGGER AS $$ DECLARE parent_path LTREE; BEGIN IF NEW.parent_folder_id IS NULL THEN NEW.path := (replace(NEW.project_id::text, '-', '_') || '.' || replace(NEW.id::text, '-', '_'))::LTREE; ELSE SELECT f.path INTO parent_path FROM folders f WHERE f.id = NEW.parent_folder_id; IF parent_path IS NULL THEN RAISE EXCEPTION 'Parent folder % not found', NEW.parent_folder_id; END IF; NEW.path := (parent_path::text || '.' || replace(NEW.id::text, '-', '_'))::LTREE; END IF; NEW.depth := nlevel(NEW.path) - 1; NEW.updated_at := NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER trg_folders_path_insert BEFORE INSERT ON folders FOR EACH ROW EXECUTE FUNCTION update_folder_path()`);
  await knex.raw(`CREATE TRIGGER trg_folders_path_update BEFORE UPDATE OF parent_folder_id ON folders FOR EACH ROW EXECUTE FUNCTION update_folder_path()`);
  await knex.raw(`CREATE TABLE datasets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name VARCHAR(255) NOT NULL, folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE, file_path TEXT NOT NULL, original_filename VARCHAR(500), mime_type VARCHAR(100), file_size_bytes BIGINT, row_count INTEGER, column_count INTEGER, schema_info JSONB, status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'error')), content_hash VARCHAR(128), created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await knex.raw(`CREATE TABLE dataset_columns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, column_name VARCHAR(255) NOT NULL, column_type VARCHAR(50) NOT NULL, ordinal_position INTEGER NOT NULL, nullable BOOLEAN DEFAULT true, sample_values JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await knex.raw(`CREATE UNIQUE INDEX uq_folders_root_name ON folders (project_id, name) WHERE parent_folder_id IS NULL`);
  await knex.raw('CREATE INDEX idx_folders_project ON folders(project_id)');
  await knex.raw('CREATE INDEX idx_folders_parent ON folders(parent_folder_id)');
  await knex.raw('CREATE INDEX idx_folders_path ON folders USING GIST(path)');
  await knex.raw('CREATE INDEX idx_datasets_folder ON datasets(folder_id)');
  await knex.raw('CREATE INDEX idx_datasets_status ON datasets(status)');
  await knex.raw('CREATE INDEX idx_dataset_cols_dataset ON dataset_columns(dataset_id)');
  await knex.raw('CREATE INDEX idx_datasets_hash ON datasets(content_hash)');
  await knex.raw(`CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await knex.raw(`CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`);
  await knex.raw(`CREATE TRIGGER trg_datasets_updated_at BEFORE UPDATE ON datasets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`);
  await knex.raw(`CREATE TRIGGER trg_dataset_columns_updated_at BEFORE UPDATE ON dataset_columns FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS dataset_columns CASCADE');
  await knex.raw('DROP TABLE IF EXISTS datasets CASCADE');
  await knex.raw('DROP TABLE IF EXISTS folders CASCADE');
  await knex.raw('DROP TABLE IF EXISTS projects CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS update_folder_path() CASCADE');
  await knex.raw('DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE');
  await knex.raw('DROP EXTENSION IF EXISTS ltree CASCADE');
}
