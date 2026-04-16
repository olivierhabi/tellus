/**
 * Foundry Data Ingestion Layer — Database Migration
 * 
 * Creates the foundry-specific tables (projects, folders, datasets, etc.)
 * alongside the existing ontology-engine tables.
 * 
 * Run with: npx tsx src/foundryMigrate.ts
 */
import { pool } from "./db";

async function migrateFoundry(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("Running foundry data ingestion layer migrations...");

    // 1. Enable ltree extension
    await client.query("CREATE EXTENSION IF NOT EXISTS ltree");
    console.log("  [1/8] ltree extension enabled");

    // 2. Projects table
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name          VARCHAR(255) NOT NULL,
        description   TEXT,
        owner_id      UUID NOT NULL,
        default_role  VARCHAR(50) DEFAULT 'viewer',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        search_vector TSVECTOR,
        CONSTRAINT uq_projects_owner_name UNIQUE (owner_id, name)
      )
    `);
    console.log("  [2/8] projects table created");

    // 3. Folders table
    await client.query(`
      CREATE TABLE IF NOT EXISTS folders (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              VARCHAR(255) NOT NULL,
        parent_folder_id  UUID REFERENCES folders(id) ON DELETE SET NULL,
        project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path              LTREE NOT NULL,
        depth             INTEGER DEFAULT 0,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        search_vector     TSVECTOR,
        CONSTRAINT uq_folders_parent_name UNIQUE (project_id, parent_folder_id, name),
        CONSTRAINT chk_folders_depth CHECK (depth = nlevel(path) - 1)
      )
    `);
    console.log("  [3/8] folders table created");

    // 4. Folder path trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION update_folder_path()
      RETURNS TRIGGER AS $$
      DECLARE
        parent_path LTREE;
      BEGIN
        IF NEW.parent_folder_id IS NULL THEN
          NEW.path := (replace(NEW.project_id::text, '-', '_') || '.' || replace(NEW.id::text, '-', '_'))::LTREE;
        ELSE
          SELECT f.path INTO parent_path FROM folders f WHERE f.id = NEW.parent_folder_id;
          IF parent_path IS NULL THEN
            RAISE EXCEPTION 'Parent folder % not found', NEW.parent_folder_id;
          END IF;
          NEW.path := (parent_path::text || '.' || replace(NEW.id::text, '-', '_'))::LTREE;
        END IF;
        NEW.depth := nlevel(NEW.path) - 1;
        NEW.updated_at := NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_folders_path_insert ON folders;
      CREATE TRIGGER trg_folders_path_insert BEFORE INSERT ON folders
      FOR EACH ROW EXECUTE FUNCTION update_folder_path()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_folders_path_update ON folders;
      CREATE TRIGGER trg_folders_path_update BEFORE UPDATE OF parent_folder_id ON folders
      FOR EACH ROW EXECUTE FUNCTION update_folder_path()
    `);
    console.log("  [4/8] folder path triggers created");

    // 5. Foundry datasets table (note: different from ontology-engine's dataset table)
    await client.query(`
      CREATE TABLE IF NOT EXISTS foundry_datasets (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name              VARCHAR(255) NOT NULL,
        folder_id         UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        file_path         TEXT NOT NULL,
        original_filename VARCHAR(500),
        mime_type         VARCHAR(100),
        file_size_bytes   BIGINT,
        row_count         INTEGER,
        column_count      INTEGER,
        schema_info       JSONB,
        status            VARCHAR(50) DEFAULT 'pending'
                          CHECK (status IN ('pending', 'processing', 'ready', 'error')),
        content_hash      VARCHAR(64),
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        search_vector     TSVECTOR
      )
    `);
    console.log("  [5/8] foundry_datasets table created");

    // 6. Dataset columns table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dataset_columns (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id        UUID NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
        column_name       VARCHAR(255) NOT NULL,
        column_type       VARCHAR(50) NOT NULL,
        ordinal_position  INTEGER NOT NULL,
        nullable          BOOLEAN DEFAULT true,
        sample_values     JSONB,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log("  [6/8] dataset_columns table created");

    // 7. Users & auth tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (project_id, user_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dataset_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id UUID NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        file_size_bytes BIGINT,
        row_count INTEGER,
        column_count INTEGER,
        content_hash VARCHAR(64),
        schema_snapshot JSONB,
        change_summary TEXT,
        created_by UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_dataset_version UNIQUE (dataset_id, version_number)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        preference_key    VARCHAR(100) NOT NULL,
        preference_value  JSONB NOT NULL,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_user_pref UNIQUE (user_id, preference_key)
      )
    `);
    console.log("  [7/8] users, auth, members, versions, user_preferences tables created");

    // 8. Indexes
    await client.query("CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_folders_path ON folders USING GIST(path)");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_root_name ON folders(project_id, name) WHERE parent_folder_id IS NULL");
    await client.query("CREATE INDEX IF NOT EXISTS idx_foundry_datasets_folder ON foundry_datasets(folder_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_foundry_datasets_status ON foundry_datasets(status)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_dataset_cols_dataset ON dataset_columns(dataset_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_foundry_datasets_hash ON foundry_datasets(content_hash)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_projects_search ON projects USING GIN(search_vector)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_folders_search ON folders USING GIN(search_vector)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_foundry_datasets_search ON foundry_datasets USING GIN(search_vector)");
    console.log("  [8/8] indexes created");

    // updated_at trigger function (if not already created by ontology-engine)
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `);

    // Apply updated_at triggers
    await client.query("DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects");
    await client.query("CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()");
    await client.query("DROP TRIGGER IF EXISTS trg_foundry_datasets_updated_at ON foundry_datasets");
    await client.query("CREATE TRIGGER trg_foundry_datasets_updated_at BEFORE UPDATE ON foundry_datasets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()");
    await client.query("DROP TRIGGER IF EXISTS trg_users_updated_at ON users");
    await client.query("CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()");

    // Backfill: ensure every project owner has a project_members row
    // Only for owners that exist in the users table (skip orphaned dev data)
    await client.query(`
      INSERT INTO project_members (project_id, user_id, role)
      SELECT p.id, p.owner_id, 'owner'
      FROM projects p
      INNER JOIN users u ON u.id = p.owner_id
      WHERE NOT EXISTS (
        SELECT 1 FROM project_members pm
        WHERE pm.project_id = p.id AND pm.user_id = p.owner_id
      )
      ON CONFLICT (project_id, user_id) DO NOTHING
    `);

    // -----------------------------------------------------------------------
    // Schema evolution: add project_id to foundry_datasets, make folder_id
    // nullable so datasets can live at the project root level.
    // -----------------------------------------------------------------------
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'foundry_datasets' AND column_name = 'project_id'
    `);
    if (colCheck.rows.length === 0) {
      await client.query(`ALTER TABLE foundry_datasets ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE`);
      await client.query(`ALTER TABLE foundry_datasets ALTER COLUMN folder_id DROP NOT NULL`);
      // Backfill project_id from the folder's project
      await client.query(`
        UPDATE foundry_datasets d
        SET project_id = f.project_id
        FROM folders f
        WHERE d.folder_id = f.id AND d.project_id IS NULL
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_foundry_datasets_project ON foundry_datasets(project_id)`);
      console.log("  [schema] foundry_datasets.project_id added, folder_id made nullable");
    }

    await client.query("COMMIT");
    console.log("\nFoundry migration complete — all tables created successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateFoundry().catch(() => process.exit(1));
