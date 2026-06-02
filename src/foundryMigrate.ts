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

    // 9. Pipelines table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name            VARCHAR(255) NOT NULL,
        description     TEXT,
        pipeline_type   VARCHAR(50) NOT NULL DEFAULT 'batch'
                        CHECK (pipeline_type IN ('batch', 'streaming')),
        compute_type    VARCHAR(50) NOT NULL DEFAULT 'standard'
                        CHECK (compute_type IN ('standard', 'lightweight', 'external')),
        status          VARCHAR(50) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'paused', 'failed', 'archived')),
        config          JSONB DEFAULT '{}'::jsonb,
        created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_pipelines_project_name UNIQUE (project_id, name)
      )
    `);
    // Schema evolution: add folder_id to pipelines for folder-scoped listing
    const pipelineFolderCol = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pipelines' AND column_name = 'folder_id'
    `);
    if (pipelineFolderCol.rows.length === 0) {
      await client.query(`ALTER TABLE pipelines ADD COLUMN folder_id UUID REFERENCES folders(id) ON DELETE SET NULL`);
      console.log("  [schema] pipelines.folder_id added");
    }

    await client.query("CREATE INDEX IF NOT EXISTS idx_pipelines_project ON pipelines(project_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pipelines_folder ON pipelines(folder_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pipelines_status ON pipelines(status)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pipelines_created_by ON pipelines(created_by)");
    await client.query("DROP TRIGGER IF EXISTS trg_pipelines_updated_at ON pipelines");
    await client.query("CREATE TRIGGER trg_pipelines_updated_at BEFORE UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()");
    console.log("  [9/10] pipelines table created");

    // PB-B2 — compute_type evolution. The pre-PB-B2 enum was
    // (standard,lightweight,external); PB-B2 re-purposes the column as
    // the TransformService engine selector (duckdb,legacy_nodejs).
    // Fresh setups take the new default; existing rows get normalised
    // to 'legacy_nodejs' so behaviour doesn't change on upgrade.
    await client.query(`ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_compute_type_check`);
    await client.query(`
      UPDATE pipelines
         SET compute_type = 'legacy_nodejs'
       WHERE compute_type IS NULL
          OR compute_type IN ('standard','lightweight','external')
    `);
    await client.query(`ALTER TABLE pipelines ALTER COLUMN compute_type SET DEFAULT 'duckdb'`);
    await client.query(`
      ALTER TABLE pipelines
        ADD CONSTRAINT pipelines_compute_type_check
        CHECK (compute_type IN ('duckdb','legacy_nodejs'))
    `);
    console.log("  [ok] pipelines.compute_type → duckdb default");

    // -----------------------------------------------------------------------
    // pipeline_deployments — create BEFORE the PB-B3..B10 ALTER blocks
    // below because they extend this table (output_snapshot_id,
    // prior_snapshot_id, idempotency_key, cancellation_requested_at,
    // flink_job_id, etc.). On a fresh CI database `ALTER TABLE
    // pipeline_deployments ...` without a prior CREATE fails with
    // PostgreSQL 42P01 (undefined_table).
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_deployments (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status          VARCHAR(50) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
        triggered_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at     TIMESTAMPTZ,
        duration_ms     INTEGER,
        config          JSONB DEFAULT '{}'::jsonb,
        error_message   TEXT,
        build_results   JSONB DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_pipeline ON pipeline_deployments(pipeline_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_project ON pipeline_deployments(project_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_status ON pipeline_deployments(status)`);
    console.log("  [ok] pipeline_deployments (moved before PB-B3..B10 ALTERs)");

    // PB-B3 — output_format + dataset format tracking.
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS output_format TEXT NOT NULL DEFAULT 'csv'`);
    await client.query(`ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_output_format_check`);
    await client.query(`
      ALTER TABLE pipelines
        ADD CONSTRAINT pipelines_output_format_check
        CHECK (output_format IN ('csv','parquet','iceberg'))
    `);
    await client.query(`ALTER TABLE foundry_datasets ADD COLUMN IF NOT EXISTS format TEXT`);
    await client.query(`UPDATE foundry_datasets SET format = 'csv' WHERE format IS NULL`);
    await client.query(`ALTER TABLE foundry_datasets ALTER COLUMN format SET NOT NULL`);
    await client.query(`ALTER TABLE foundry_datasets ALTER COLUMN format SET DEFAULT 'csv'`);
    await client.query(`ALTER TABLE foundry_datasets DROP CONSTRAINT IF EXISTS foundry_datasets_format_check`);
    await client.query(`
      ALTER TABLE foundry_datasets
        ADD CONSTRAINT foundry_datasets_format_check
        CHECK (format IN ('csv','parquet','iceberg'))
    `);
    await client.query(`ALTER TABLE foundry_datasets ADD COLUMN IF NOT EXISTS row_count_exact BIGINT`);
    await client.query(`ALTER TABLE dataset_columns ADD COLUMN IF NOT EXISTS logical_type TEXT`);
    console.log("  [ok] pipelines.output_format + dataset format tracking");

    // PB-B4 — Iceberg outputs via Lakekeeper.
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS iceberg_partition_spec JSONB`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS output_snapshot_id BIGINT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS prior_snapshot_id BIGINT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS output_table_location TEXT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS iceberg_retry_count INTEGER NOT NULL DEFAULT 0`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_snapshot
        ON pipeline_deployments (pipeline_id, output_snapshot_id)
        WHERE output_snapshot_id IS NOT NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_changelog_watermark (
        pipeline_id           UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        consumer              TEXT        NOT NULL,
        last_from_snapshot_id BIGINT,
        last_to_snapshot_id   BIGINT,
        last_advanced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_rows_emitted     BIGINT      NOT NULL DEFAULT 0,
        PRIMARY KEY (pipeline_id, consumer)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_changelog_watermark_consumer
        ON pipeline_changelog_watermark (consumer, last_advanced_at DESC)
    `);
    console.log("  [ok] PB-B4 iceberg columns + watermark");

    // PB-B5 — streaming pipelines via Flink + ThroughputGuard.
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS streaming_runtime TEXT`);
    await client.query(`ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_streaming_runtime_check`);
    await client.query(`
      ALTER TABLE pipelines
        ADD CONSTRAINT pipelines_streaming_runtime_check
        CHECK (streaming_runtime IS NULL OR streaming_runtime IN ('flink','kafka_streams'))
    `);
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS streaming_parallelism INTEGER`);
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS streaming_throughput_mbps INTEGER`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS flink_job_id TEXT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS savepoint_path TEXT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS streaming_runtime TEXT`);
    await client.query(`
      UPDATE pipeline_deployments
         SET status = 'failed'
       WHERE status NOT IN ('running','succeeded','failed','cancelled',
                            'running_streaming','draining')
    `);
    await client.query(`ALTER TABLE pipeline_deployments DROP CONSTRAINT IF EXISTS pipeline_deployments_status_check`);
    await client.query(`
      ALTER TABLE pipeline_deployments
        ADD CONSTRAINT pipeline_deployments_status_check
        CHECK (status IN ('running','succeeded','failed','cancelled',
                          'running_streaming','draining'))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_streaming
        ON pipeline_deployments (pipeline_id, flink_job_id)
        WHERE flink_job_id IS NOT NULL
    `);
    console.log("  [ok] PB-B5 streaming columns");

    // PB-B6 — snapshot-pinned deploys.
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS input_snapshots JSONB`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS divergence_warning BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS ignore_preview_snapshot BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS preview_chain_hash TEXT`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_divergence
        ON pipeline_deployments (pipeline_id)
        WHERE divergence_warning = TRUE
    `);
    console.log("  [ok] PB-B6 snapshot pinning columns");

    // PB-B7 — RBAC + marking propagation.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_acl (
        pipeline_id    UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        principal_id   UUID NOT NULL,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group')),
        role           TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
        granted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        granted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (pipeline_id, principal_id, principal_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_acl_principal ON pipeline_acl (principal_id, principal_type)`);
    await client.query(`ALTER TABLE foundry_datasets ADD COLUMN IF NOT EXISTS markings TEXT[] NOT NULL DEFAULT '{}'::text[]`);
    await client.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS input_markings TEXT[] NOT NULL DEFAULT '{}'::text[]`);
    await client.query(`
      INSERT INTO pipeline_acl (pipeline_id, principal_id, principal_type, role, granted_by)
      SELECT p.id, p.created_by, 'user', 'owner', p.created_by
        FROM pipelines p
       WHERE p.created_by IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_acl a
            WHERE a.pipeline_id = p.id
              AND a.principal_id = p.created_by
              AND a.principal_type = 'user'
         )
    `);
    console.log("  [ok] PB-B7 pipeline_acl + markings");

    // PB-B8 — dataset lineage graph.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dataset_lineage (
        downstream_dataset_id UUID        NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
        upstream_dataset_id   UUID        NOT NULL REFERENCES foundry_datasets(id) ON DELETE CASCADE,
        edge_type             TEXT        NOT NULL
                               CHECK (edge_type IN ('pipeline_output','funnel_input','virtual_table')),
        edge_metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (downstream_dataset_id, upstream_dataset_id, edge_type),
        CONSTRAINT dataset_lineage_not_self CHECK (downstream_dataset_id <> upstream_dataset_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dataset_lineage_upstream
        ON dataset_lineage (upstream_dataset_id)
        INCLUDE (downstream_dataset_id, edge_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dataset_lineage_downstream
        ON dataset_lineage (downstream_dataset_id)
    `);
    console.log("  [ok] PB-B8 dataset_lineage");

    // PB-B7 follow-cbac — condition-based access control rules.
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_cbac_rule (
        rule_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_id  UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        description  TEXT,
        predicate    JSONB       NOT NULL,
        enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_cbac_rule_pipeline
        ON pipeline_cbac_rule (pipeline_id)
        WHERE enabled = TRUE
    `);
    console.log("  [ok] PB-B7 follow-cbac pipeline_cbac_rule");

    // PB-B8 follow-fnl-h3 — new 'pipelineDeployCompleted' signal type.
    await client.query(`ALTER TABLE funnel_signal DROP CONSTRAINT IF EXISTS funnel_signal_signal_type_check`);
    await client.query(`
      ALTER TABLE funnel_signal
        ADD CONSTRAINT funnel_signal_signal_type_check
        CHECK (signal_type IN (
          'sourceTransactionCommitted',
          'editBatchPending',
          'schemaChanged',
          'pipelineDeployCompleted'
        ))
    `);
    console.log("  [ok] PB-B8 follow-fnl-h3 signal enum");

    // PB-B8 follow-bd-migrate — modern FK to foundry_datasets alongside
    // the legacy `dataset_id` column.
    await client.query(`
      ALTER TABLE backing_datasource
        ADD COLUMN IF NOT EXISTS foundry_dataset_id UUID
          REFERENCES foundry_datasets(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_backing_datasource_foundry_dataset
        ON backing_datasource (foundry_dataset_id)
        WHERE foundry_dataset_id IS NOT NULL
    `);
    console.log("  [ok] PB-B8 follow-bd-migrate foundry_dataset_id");

    // PB-B10 — schema evolution fingerprint audit.
    await client.query(`ALTER TABLE foundry_datasets ADD COLUMN IF NOT EXISTS last_output_schema_fingerprint TEXT`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_foundry_datasets_schema_fp
        ON foundry_datasets (last_output_schema_fingerprint)
        WHERE last_output_schema_fingerprint IS NOT NULL
    `);
    console.log("  [ok] PB-B10 schema fingerprint column");

    // 10. Pipeline nodes table — stores individual nodes within a pipeline graph
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_nodes (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_id     UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        dataset_id      UUID REFERENCES foundry_datasets(id) ON DELETE SET NULL,
        node_type       VARCHAR(50) NOT NULL DEFAULT 'dataset'
                        CHECK (node_type IN ('dataset', 'transform', 'join', 'union', 'output')),
        label           VARCHAR(255) NOT NULL,
        position_x      DOUBLE PRECISION NOT NULL DEFAULT 0,
        position_y      DOUBLE PRECISION NOT NULL DEFAULT 0,
        config          JSONB DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_pipeline_nodes_pipeline ON pipeline_nodes(pipeline_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_pipeline_nodes_dataset ON pipeline_nodes(dataset_id)");
    await client.query("DROP TRIGGER IF EXISTS trg_pipeline_nodes_updated_at ON pipeline_nodes");
    await client.query("CREATE TRIGGER trg_pipeline_nodes_updated_at BEFORE UPDATE ON pipeline_nodes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()");
    console.log("  [10/10] pipeline_nodes table created");

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

    // -----------------------------------------------------------------------
    // Schema evolution: add created_by / updated_by to foundry_datasets
    // so the API can return who created or last modified a dataset.
    // -----------------------------------------------------------------------
    const createdByCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'foundry_datasets' AND column_name = 'created_by'
    `);
    if (createdByCheck.rows.length === 0) {
      await client.query(`ALTER TABLE foundry_datasets ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE foundry_datasets ADD COLUMN updated_by UUID REFERENCES users(id) ON DELETE SET NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_foundry_datasets_created_by ON foundry_datasets(created_by)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_foundry_datasets_updated_by ON foundry_datasets(updated_by)`);
      console.log("  [schema] foundry_datasets.created_by / updated_by added");
    }

    // -----------------------------------------------------------------------
    // PB-B1 — supervised deploys (idempotency, cancellation, orphan sweeper).
    // (pipeline_deployments itself is created earlier, above the PB-B3..B10
    // ALTER blocks, so those ALTERs don't fire against an undefined_table.)
    // Mirrors migrations/033_pipeline_supervised_deploys.sql so fresh
    // environments boot with the full surface.
    // -----------------------------------------------------------------------
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE pipeline_deployments ADD COLUMN IF NOT EXISTS max_run_duration_seconds INTEGER NOT NULL DEFAULT 14400`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pipeline_deployments_idempotency_unique
        ON pipeline_deployments (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_deployments_running
        ON pipeline_deployments (started_at)
        WHERE status = 'running'
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_signal (
        signal_id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        pipeline_id               UUID        NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        project_id                UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        deployment_id             UUID        REFERENCES pipeline_deployments(id) ON DELETE CASCADE,
        signal_type               TEXT        NOT NULL
                                   CHECK (signal_type IN ('deployStart','cancelDeployment')),
        payload                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
        signal_fingerprint        TEXT,
        received_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        consumed_at               TIMESTAMPTZ,
        consumed_by_deployment_id UUID        REFERENCES pipeline_deployments(id) ON DELETE SET NULL,
        redelivery_count          INTEGER     NOT NULL DEFAULT 0
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pipeline_signal_pending
        ON pipeline_signal (pipeline_id, received_at ASC)
        WHERE consumed_at IS NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pipeline_signal_fingerprint_unique
        ON pipeline_signal (pipeline_id, signal_fingerprint)
        WHERE signal_fingerprint IS NOT NULL
    `);
    console.log("  [ok] pipeline_signal + PB-B1 columns");

    // -----------------------------------------------------------------------
    // PB-B4 invariant + PB-B1 idempotency-key enforcement
    // (migrations/031_pipeline_snapshot_invariants.sql, inlined here so
    // a fresh `npm run migrate:foundry` picks them up without a side
    // runner). Triggers are idempotent via CREATE OR REPLACE + DROP
    // TRIGGER IF EXISTS.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION pipeline_deployments_check_snapshot_invariant()
      RETURNS TRIGGER AS $$
      DECLARE
        fmt TEXT;
      BEGIN
        IF NEW.status = 'succeeded' AND NEW.output_snapshot_id IS NULL THEN
          SELECT p.output_format INTO fmt
            FROM pipelines p
           WHERE p.id = NEW.pipeline_id;
          IF fmt = 'iceberg' THEN
            RAISE EXCEPTION
              'PB-B4 invariant: pipeline_deployments.output_snapshot_id must be set when status=succeeded AND pipelines.output_format=iceberg (deployment_id=%)',
              NEW.id
              USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_pipeline_deployments_snapshot_invariant
        ON pipeline_deployments
    `);
    await client.query(`
      CREATE TRIGGER trg_pipeline_deployments_snapshot_invariant
        BEFORE INSERT OR UPDATE OF status, output_snapshot_id ON pipeline_deployments
        FOR EACH ROW
        EXECUTE FUNCTION pipeline_deployments_check_snapshot_invariant()
    `);

    await client.query(`
      UPDATE pipeline_deployments
         SET idempotency_key = 'legacy-' || id::text
       WHERE idempotency_key IS NULL
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION pipeline_deployments_require_idempotency_key()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.idempotency_key IS NULL THEN
          RAISE EXCEPTION
            'pipeline_deployments.idempotency_key is required (PB-B1 deprecation window closed in migration 031)'
            USING ERRCODE = '23502';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS trg_pipeline_deployments_require_idempotency_key
        ON pipeline_deployments
    `);
    await client.query(`
      CREATE TRIGGER trg_pipeline_deployments_require_idempotency_key
        BEFORE INSERT ON pipeline_deployments
        FOR EACH ROW
        EXECUTE FUNCTION pipeline_deployments_require_idempotency_key()
    `);
    console.log("  [ok] PB-B4 snapshot invariant + PB-B1 idempotency key triggers");

    // -----------------------------------------------------------------------
    // Files & Projects B1 — Compass Resource Model & RID System
    //
    // Spec: tasks/files-projects/files-projects-tasks.md:47-138.
    // Contracts: B1-C-10 .. B1-C-15. The grammar regex MUST match
    // src/lib/rid.ts:RID_REGEX. A divergence is a B1-X-01 violation.
    //
    // The block is fully idempotent (CREATE … IF NOT EXISTS, CREATE OR
    // REPLACE FUNCTION, INSERT … ON CONFLICT DO NOTHING) so re-running
    // foundryMigrate produces zero changes (B1-C-13).
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS resources (
        rid                  text PRIMARY KEY
                             CHECK (rid ~ '^ri\\.[a-z][a-z0-9-]*\\.([a-z0-9][a-z0-9-]*)?\\.[a-z][a-z0-9-]*\\..+$'),
        service              text NOT NULL,
        type                 text NOT NULL,
        display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
        description          text,
        documentation        text,
        parent_folder_rid    text REFERENCES resources(rid) ON DELETE RESTRICT,
        project_rid          text REFERENCES resources(rid) ON DELETE RESTRICT,
        space_rid            text REFERENCES resources(rid) ON DELETE RESTRICT,
        trash_status         text NOT NULL DEFAULT 'NOT_TRASHED'
                             CHECK (trash_status IN ('NOT_TRASHED','DIRECTLY_TRASHED','ANCESTOR_TRASHED')),
        created_by           uuid NOT NULL REFERENCES users(id),
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid NOT NULL REFERENCES users(id),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        etag                 bigint NOT NULL DEFAULT 1,
        metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
        legacy_uuid          uuid UNIQUE
      )
    `);
    // space_rid is NOT NULL on every non-space row. The root space row is
    // its own space, so we enforce via a partial CHECK rather than a hard
    // NOT NULL. Adding the constraint idempotently:
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'resources_space_rid_required'
        ) THEN
          ALTER TABLE resources ADD CONSTRAINT resources_space_rid_required
            CHECK (space_rid IS NOT NULL OR (type = 'COMPASS_SPACE' AND rid = space_rid IS NOT FALSE));
        END IF;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS resources_parent_idx  ON resources (parent_folder_rid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS resources_project_idx ON resources (project_rid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS resources_space_idx   ON resources (space_rid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS resources_type_idx    ON resources (type)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS resources_trash_idx
        ON resources (trash_status) WHERE trash_status <> 'NOT_TRASHED'
    `);

    // ETag bump trigger — B1-C-12. updated_at and etag are advanced by the
    // trigger so callers can issue UPDATE without an explicit set.
    await client.query(`
      CREATE OR REPLACE FUNCTION resources_bump_etag() RETURNS trigger AS $$
      BEGIN
        NEW.etag := COALESCE(OLD.etag, 0) + 1;
        NEW.updated_at := now();
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS resources_bump_etag_t ON resources`);
    await client.query(`
      CREATE TRIGGER resources_bump_etag_t BEFORE UPDATE ON resources
      FOR EACH ROW EXECUTE FUNCTION resources_bump_etag()
    `);
    console.log("  [ok] B1: resources table + indexes + etag trigger");

    // -----------------------------------------------------------------------
    // Backfill — B1-C-14. Every existing projects / folders / foundry_datasets
    // row gets a resources row. Idempotent via UNIQUE(legacy_uuid).
    //
    // The root space RID is hard-coded here (matches src/lib/rid.ts:ROOT_SPACE_RID
    // and is minted by B2). To unblock B1 standalone, we mint it inline if
    // absent — B2 will fold the spaces table creation around it.
    // -----------------------------------------------------------------------
    const ROOT_SPACE_RID =
      "ri.compass.main.space.00000000-0000-0000-0000-000000000000";

    // Find a stable user to attribute the root space to. The root space's
    // `resources` row (and the parallel `spaces` row in B2 below) needs a
    // `created_by`/`updated_by` FK into users(id). On a genuinely fresh
    // database no user has authenticated yet. The original design deferred
    // the root-space insert to "the next migrate run, after the first user
    // lands" — but that run never happens for an ephemeral CI database (which
    // migrates exactly once) or for a first deploy that creates a project
    // before the second migrate. The result: every project-creating path
    // fails its resources.space_rid FK, and the spaces-B2 invariant tests
    // (which assert the migration materialised the root space) fail too.
    //
    // So instead of deferring, mint a stable system user when none exists and
    // create the root space on this run. Idempotent: ON CONFLICT (email).
    let { rows: userRows } = await client.query<{ id: string }>(
      `SELECT id FROM users ORDER BY created_at LIMIT 1`,
    );
    if (userRows.length === 0) {
      await client.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ('system@tellus.local', gen_random_uuid()::text, 'System')
         ON CONFLICT (email) DO NOTHING`,
      );
      ({ rows: userRows } = await client.query<{ id: string }>(
        `SELECT id FROM users ORDER BY created_at LIMIT 1`,
      ));
      console.log("  [ok] B1: minted system user to own the root space (fresh install)");
    }
    if (userRows.length > 0) {
      const seedUserId = userRows[0].id;
      // Two-step insert: (a) create the root space resources row pointing at
      // itself; (b) backfill projects/folders/foundry_datasets.
      await client.query(
        `
        INSERT INTO resources (rid, service, type, display_name, space_rid,
                               created_by, updated_by)
        VALUES ($1, 'compass', 'COMPASS_SPACE', 'Root', $1, $2, $2)
        ON CONFLICT (rid) DO NOTHING
        `,
        [ROOT_SPACE_RID, seedUserId],
      );

      // Project backfill. parent_folder_rid stays NULL (projects sit at the
      // top of the folder tree). project_rid is the project's own rid (a
      // project is in itself for path-resolution purposes; B2 enshrines this).
      await client.query(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        SELECT 'ri.compass.main.project.' || p.id::text,
               'compass', 'PROJECT', p.name,
               NULL,
               'ri.compass.main.project.' || p.id::text,
               $1,
               p.owner_id, p.created_at, p.owner_id, p.updated_at,
               p.id
        FROM projects p
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [ROOT_SPACE_RID],
      );

      // Folder backfill. parent_folder_rid points at the parent folder's
      // backfilled RID, falling back to the project RID for top-level folders.
      // project_rid is always the project's rid.
      await client.query(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        SELECT 'ri.compass.main.compass-folder.' || f.id::text,
               'compass', 'COMPASS_FOLDER', f.name,
               CASE
                 WHEN f.parent_folder_id IS NULL
                   THEN 'ri.compass.main.project.' || f.project_id::text
                 ELSE 'ri.compass.main.compass-folder.' || f.parent_folder_id::text
               END,
               'ri.compass.main.project.' || f.project_id::text,
               $1,
               COALESCE(
                 (SELECT owner_id FROM projects WHERE id = f.project_id),
                 (SELECT id FROM users ORDER BY created_at LIMIT 1)
               ),
               f.created_at,
               COALESCE(
                 (SELECT owner_id FROM projects WHERE id = f.project_id),
                 (SELECT id FROM users ORDER BY created_at LIMIT 1)
               ),
               f.updated_at,
               f.id
        FROM folders f
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [ROOT_SPACE_RID],
      );

      // Foundry dataset backfill. The dataset lives in its enclosing folder.
      await client.query(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        SELECT 'ri.compass.main.foundry-dataset.' || d.id::text,
               'compass', 'FOUNDRY_DATASET', d.name,
               'ri.compass.main.compass-folder.' || d.folder_id::text,
               (SELECT 'ri.compass.main.project.' || f.project_id::text
                  FROM folders f WHERE f.id = d.folder_id),
               $1,
               COALESCE(
                 (SELECT p.owner_id
                    FROM folders f JOIN projects p ON p.id = f.project_id
                   WHERE f.id = d.folder_id),
                 (SELECT id FROM users ORDER BY created_at LIMIT 1)
               ),
               d.created_at,
               COALESCE(
                 (SELECT p.owner_id
                    FROM folders f JOIN projects p ON p.id = f.project_id
                   WHERE f.id = d.folder_id),
                 (SELECT id FROM users ORDER BY created_at LIMIT 1)
               ),
               d.updated_at,
               d.id
        FROM foundry_datasets d
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [ROOT_SPACE_RID],
      );
      console.log("  [ok] B1: resources backfill (root space + projects + folders + foundry_datasets)");
    } else {
      console.log("  [skip] B1: backfill deferred — no users yet (fresh install)");
    }

    // -----------------------------------------------------------------------
    // Files & Projects B2 — Spaces & Hierarchy Refactor
    //
    // Spec:      tasks/files-projects/files-projects-tasks.md:140-200
    // Contracts: tasks/files-projects/contracts.md (B2-C-01..B2-C-05).
    //
    // B1 already minted the root space's `resources` row (type='COMPASS_SPACE',
    // self-referential space_rid). B2 adds the parallel `spaces` table that
    // carries the space-specific metadata (enrollment, file_system_id, etc.)
    // and the partial unique index that enforces "at most one root".
    //
    // Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
    // INSERT ... ON CONFLICT DO NOTHING.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS spaces (
        rid                       text PRIMARY KEY REFERENCES resources(rid) ON DELETE RESTRICT,
        display_name              text NOT NULL,
        enrollment_rid            text NOT NULL,
        default_role_set_id       text NOT NULL DEFAULT 'compass-default',
        file_system_id            uuid NOT NULL,
        usage_account_rid         text,
        is_root                   boolean NOT NULL DEFAULT false,
        created_at                timestamptz NOT NULL DEFAULT now()
      )
    `);
    // B2-C-02: at most one row may carry is_root=true.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_root_idx
        ON spaces ((true)) WHERE is_root
    `);

    // B2-C-03: mint the root space row in `spaces` if missing. The matching
    // `resources` row was minted by B1 (or will be on the next migrate after
    // a user lands), so this INSERT is gated on its presence.
    const ROOT_SPACE_RID_B2 =
      "ri.compass.main.space.00000000-0000-0000-0000-000000000000";
    const rootResource = await client.query<{ rid: string }>(
      `SELECT rid FROM resources WHERE rid = $1`,
      [ROOT_SPACE_RID_B2],
    );
    if (rootResource.rows.length > 0) {
      await client.query(
        `
        INSERT INTO spaces (rid, display_name, enrollment_rid, file_system_id, is_root)
        VALUES ($1, 'Root', 'ri.compass.main.enrollment.default', gen_random_uuid(), true)
        ON CONFLICT (rid) DO NOTHING
        `,
        [ROOT_SPACE_RID_B2],
      );
      console.log("  [ok] B2: spaces table + root space row");
    } else {
      console.log("  [skip] B2: root space row deferred — B1 has not yet seeded resources");
    }

    // -----------------------------------------------------------------------
    // idempotency_keys — Idempotency-Key replay cache.
    //
    // Stores the (status_code, response_body, response_etag, request_hash)
    // tuple for state-allocating POST endpoints (e.g. the ontology
    // save-to-ontology commit) so that retries within 24h return the
    // cached response with `Idempotent-Replay: true`. Lookups already
    // filter `expires_at > now()`, so a missing TTL sweep job is a space
    // hazard, not a correctness one.
    // -----------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key             uuid PRIMARY KEY,
        endpoint        text NOT NULL,
        request_hash    text NOT NULL,
        status_code     integer NOT NULL CHECK (status_code BETWEEN 100 AND 599),
        response_body   jsonb NOT NULL DEFAULT '{}',
        response_etag   text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx
        ON idempotency_keys (expires_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idempotency_keys_endpoint_idx
        ON idempotency_keys (endpoint, created_at DESC)
    `);
    console.log("  [ok] B3: idempotency_keys table");

    // === B4 Step 12: roles + role_operations ============================
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id            text PRIMARY KEY,
        display_name  text NOT NULL,
        description   text,
        is_system     boolean NOT NULL DEFAULT false,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_operations (
        role_id       text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        operation_id  text NOT NULL,
        PRIMARY KEY (role_id, operation_id)
      )
    `);
    await client.query(`
      INSERT INTO roles (id, display_name, description, is_system) VALUES
        ('compass-owner','Owner','Full control of the resource',true),
        ('compass-editor','Editor','Read + write the resource',true),
        ('compass-viewer','Viewer','Read-only access',true),
        ('compass-discoverer','Discoverer','Can see the resource exists',true)
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(`
      INSERT INTO role_operations (role_id, operation_id) VALUES
        ('compass-owner','compass:view-resource'),
        ('compass-owner','compass:edit-resource'),
        ('compass-owner','compass:delete-resource'),
        ('compass-owner','compass:share-resource'),
        ('compass-owner','compass:create-children'),
        ('compass-owner','compass:manage-permissions'),
        ('compass-editor','compass:view-resource'),
        ('compass-editor','compass:edit-resource'),
        ('compass-editor','compass:create-children'),
        ('compass-viewer','compass:view-resource'),
        ('compass-discoverer','compass:discover-resource')
      ON CONFLICT DO NOTHING
    `);
    console.log("  [ok] B4 Step 12: roles + role_operations + seed");

    // === B4 Step 13: role_grants ========================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_grants (
        resource_rid    text NOT NULL,
        principal_id    uuid,
        principal_type  text NOT NULL CHECK (principal_type IN ('USER','EVERYONE','ORG')),
        role_id         text NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        granted_by      uuid,
        granted_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (resource_rid, principal_id, role_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS role_grants_principal_idx
        ON role_grants (principal_id)
    `);
    // EVERYONE grants legitimately have NULL principal_id; the original
    // migration plan made the column nullable but an older variant created
    // it NOT NULL. Drop NOT NULL idempotently and rebuild PK with
    // NULLS NOT DISTINCT (Postgres 15+) so (rid, NULL, role) is uniquable.
    await client.query(`
      DO $$
      DECLARE has_pk boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.role_grants'::regclass
            AND conname = 'role_grants_pkey'
        ) INTO has_pk;
        IF has_pk THEN
          ALTER TABLE role_grants DROP CONSTRAINT role_grants_pkey;
        END IF;
      END $$;
    `);
    await client.query(`ALTER TABLE role_grants ALTER COLUMN principal_id DROP NOT NULL`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS role_grants_unique_idx
        ON role_grants (resource_rid, principal_id, role_id) NULLS NOT DISTINCT
    `);
    console.log("  [ok] B4 Step 13: role_grants");

    // === B4 Step 14: project_members mirror trigger =====================
    await client.query(`
      CREATE OR REPLACE FUNCTION mirror_project_members_to_role_grants() RETURNS trigger AS $func$
      DECLARE role_id_val text;
      BEGIN
        role_id_val := CASE NEW.role
          WHEN 'owner' THEN 'compass-owner'
          WHEN 'editor' THEN 'compass-editor'
          WHEN 'viewer' THEN 'compass-viewer'
          ELSE NULL
        END;
        IF role_id_val IS NULL THEN
          RETURN NEW;
        END IF;
        INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
        VALUES (
          'ri.compass.main.project.' || NEW.project_id::text,
          NEW.user_id, 'USER', role_id_val, NEW.user_id
        )
        ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING;
        RETURN NEW;
      END $func$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS project_members_mirror_t ON project_members`);
    await client.query(`
      CREATE TRIGGER project_members_mirror_t
      AFTER INSERT OR UPDATE ON project_members
      FOR EACH ROW EXECUTE FUNCTION mirror_project_members_to_role_grants()
    `);
    console.log("  [ok] B4 Step 14: project_members mirror trigger");

    // === B4 Step 15: backfill existing project_members → role_grants ====
    await client.query(`
      INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
      SELECT
        'ri.compass.main.project.' || pm.project_id::text,
        pm.user_id,
        'USER',
        CASE pm.role
          WHEN 'owner' THEN 'compass-owner'
          WHEN 'editor' THEN 'compass-editor'
          WHEN 'viewer' THEN 'compass-viewer'
        END,
        pm.user_id
      FROM project_members pm
      WHERE pm.role IN ('owner','editor','viewer')
      ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING
    `);
    console.log("  [ok] B4 Step 15: backfilled project_members → role_grants");

    // === B4 Step 16: markings, resource_markings, user_markings =========
    await client.query(`
      CREATE TABLE IF NOT EXISTS markings (
        id            text PRIMARY KEY,
        display_name  text NOT NULL,
        description   text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS resource_markings (
        resource_rid  text NOT NULL,
        marking_id    text NOT NULL REFERENCES markings(id) ON DELETE CASCADE,
        source        text NOT NULL CHECK (source IN ('DIRECT','INHERITED','DATA_LINEAGE')),
        applied_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (resource_rid, marking_id, source)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_markings (
        user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        marking_id   text NOT NULL REFERENCES markings(id) ON DELETE CASCADE,
        granted_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, marking_id)
      )
    `);
    console.log("  [ok] B4 Step 16: markings, resource_markings, user_markings");

    // === B4 Step 17: organizations + membership joins ====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id            uuid PRIMARY KEY,
        name          text NOT NULL,
        display_name  text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_organizations (
        user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        joined_at     timestamptz NOT NULL DEFAULT now(),
        is_guest      boolean NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, org_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_organizations (
        project_rid   text NOT NULL,
        org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        attached_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_rid, org_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS space_organizations (
        space_rid     text NOT NULL,
        org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        attached_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (space_rid, org_id)
      )
    `);

    // === B4 Step 18: seed default organization ============================
    await client.query(`
      INSERT INTO organizations (id, name, display_name) VALUES
        ('00000000-0000-0000-0000-000000000001'::uuid, 'default', 'Default Organization')
      ON CONFLICT DO NOTHING
    `);

    // === B4 Step 19: backfill users + projects into default org ==========
    await client.query(`
      INSERT INTO user_organizations (user_id, org_id)
      SELECT id, '00000000-0000-0000-0000-000000000001'::uuid
      FROM users
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      INSERT INTO project_organizations (project_rid, org_id)
      SELECT 'ri.compass.main.project.' || id::text,
             '00000000-0000-0000-0000-000000000001'::uuid
      FROM projects
      ON CONFLICT DO NOTHING
    `);
    console.log("  [ok] B4 Step 17-19: organizations + seeds + backfills");

    // === B4 Step 20 (B4.10): NOTIFY triggers for cache invalidation =====
    await client.query(`
      CREATE OR REPLACE FUNCTION gatekeeper_notify_invalidate() RETURNS trigger AS $func$
      BEGIN
        PERFORM pg_notify('gatekeeper_invalidate', '*');
        RETURN COALESCE(NEW, OLD);
      END $func$ LANGUAGE plpgsql
    `);
    for (const tbl of [
      'role_grants','user_organizations','project_organizations',
      'resource_markings','user_markings','roles','role_operations',
    ]) {
      await client.query(`DROP TRIGGER IF EXISTS gk_invalidate_t ON ${tbl}`);
      await client.query(`
        CREATE TRIGGER gk_invalidate_t AFTER INSERT OR UPDATE OR DELETE ON ${tbl}
        FOR EACH STATEMENT EXECUTE FUNCTION gatekeeper_notify_invalidate()
      `);
    }
    console.log("  [ok] B4 Step 20: gatekeeper_invalidate NOTIFY triggers");

    // === B5 Step 01 (B5.01): audit_log DDL ==============================
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id        uuid NOT NULL UNIQUE,
        actor_id        uuid,
        operation_id    text NOT NULL,
        resource_rid    text,
        decision        text NOT NULL CHECK (decision IN ('ALLOW','DENY')),
        reason          text,
        request_id      text,
        ip              inet,
        metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log (resource_rid, created_at DESC)`);
    console.log("  [ok] B5 Step 01: audit_log");

    // === B5 Step 04 (B5.04): trash columns + retention =================
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS trashed_at timestamptz`);
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS trashed_by uuid`);
    await client.query(`ALTER TABLE resources ADD COLUMN IF NOT EXISTS retention_until timestamptz`);
    console.log("  [ok] B5 Step 04: resources.trashed_at + retention_until");

    // === B6 Step 01 (B6.01): resource_dependencies =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS resource_dependencies (
        upstream_rid    text NOT NULL,
        downstream_rid  text NOT NULL,
        edge_type       text NOT NULL DEFAULT 'DEPENDS_ON',
        created_by      uuid,
        created_at      timestamptz NOT NULL DEFAULT now(),
        metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (upstream_rid, downstream_rid, edge_type),
        CHECK (upstream_rid <> downstream_rid)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS resource_deps_up_idx ON resource_dependencies (upstream_rid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS resource_deps_down_idx ON resource_dependencies (downstream_rid)`);
    console.log("  [ok] B6 Step 01: resource_dependencies");

    // === B6 Step 02 (B6.02): project_references =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_references (
        owner_project_rid    text NOT NULL,
        referenced_resource_rid text NOT NULL,
        reference_type       text NOT NULL DEFAULT 'IMPORT',
        created_by           uuid,
        created_at           timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_project_rid, referenced_resource_rid, reference_type)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS proj_refs_owner_idx ON project_references (owner_project_rid)`);
    await client.query(`CREATE INDEX IF NOT EXISTS proj_refs_target_idx ON project_references (referenced_resource_rid)`);
    console.log("  [ok] B6 Step 02: project_references");

    // === B7 Step 01 (B7.01): branches + branch_resources ================
    await client.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        project_rid   text NOT NULL,
        name          text NOT NULL,
        parent_branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
        status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','MERGED','CLOSED','ABANDONED')),
        created_by    uuid,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        merged_at     timestamptz,
        UNIQUE (project_rid, name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS branches_project_idx ON branches (project_rid)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_resources (
        branch_id     uuid REFERENCES branches(id) ON DELETE CASCADE,
        resource_rid  text NOT NULL,
        added_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (branch_id, resource_rid)
      )
    `);
    console.log("  [ok] B7 Step 01: branches + branch_resources");

    // === B7 Step 02 (B7.02): proposals + proposal_approvals =============
    await client.query(`
      CREATE TABLE IF NOT EXISTS proposals (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        branch_id      uuid REFERENCES branches(id) ON DELETE CASCADE,
        title          text NOT NULL,
        description    text,
        status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED','MERGED','CLOSED')),
        opened_by      uuid,
        opened_at      timestamptz NOT NULL DEFAULT now(),
        closed_at      timestamptz
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS proposal_approvals (
        proposal_id    uuid REFERENCES proposals(id) ON DELETE CASCADE,
        approver_id    uuid NOT NULL,
        decision       text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
        comment        text,
        decided_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (proposal_id, approver_id)
      )
    `);
    console.log("  [ok] B7 Step 02: proposals + proposal_approvals");

    // === B7 Step 03 (B7.03): approval_policies + branch_overlays ========
    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_policies (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        scope_rid       text NOT NULL,
        required_count  int  NOT NULL DEFAULT 1,
        rule_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_overlays (
        branch_id     uuid REFERENCES branches(id) ON DELETE CASCADE,
        resource_rid  text NOT NULL,
        operation     text NOT NULL CHECK (operation IN ('UPSERT','DELETE','RENAME')),
        payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (branch_id, resource_rid, operation)
      )
    `);
    console.log("  [ok] B7 Step 03: approval_policies + branch_overlays");

    // === B8 Step 27 (B8.01): ontologies table + default seed ===========
    await client.query(`
      CREATE TABLE IF NOT EXISTS ontologies (
        rid          text PRIMARY KEY,
        api_name     text NOT NULL UNIQUE,
        display_name text NOT NULL,
        space_rid    text NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      INSERT INTO ontologies (rid, api_name, display_name, space_rid)
      VALUES ('ri.ontology.main.ontology.default', 'default', 'Default Ontology',
              'ri.compass.main.space.00000000-0000-0000-0000-000000000000')
      ON CONFLICT (rid) DO NOTHING
    `);
    console.log("  [ok] B8 Step 27: ontologies + default seed");

    // === B8 Step 28 (B8.02): object_types ===============================
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_types (
        rid              text PRIMARY KEY,
        ontology_rid     text NOT NULL REFERENCES ontologies(rid) ON DELETE CASCADE,
        branch_rid       text,
        api_name         text NOT NULL,
        display_name     text NOT NULL,
        plural_display_name text,
        title_property   text,
        primary_keys     text[] NOT NULL DEFAULT '{}',
        status           text NOT NULL DEFAULT 'EXPERIMENTAL'
                           CHECK (status IN ('EXPERIMENTAL','ACTIVE','DEPRECATED')),
        etag             int  NOT NULL DEFAULT 1,
        created_by       uuid,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    // NULL-tolerant uniqueness on (ontology, branch, api_name): in PG,
    // UNIQUE(...) treats NULL as distinct, so we COALESCE branch_rid to
    // a sentinel for the unique key. We drop the original constraint
    // (added in an earlier rev) before adding the new index so re-runs
    // converge.
    await client.query(`
      ALTER TABLE object_types DROP CONSTRAINT IF EXISTS object_types_ontology_rid_branch_rid_api_name_key
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS object_types_unique_idx
        ON object_types (ontology_rid, COALESCE(branch_rid, '__main__'), api_name)
    `);
    console.log("  [ok] B8 Step 28: object_types");

    // === B8 Step 29 (B8.03): object_type_properties =====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_properties (
        object_type_rid text NOT NULL REFERENCES object_types(rid) ON DELETE CASCADE,
        api_name        text NOT NULL,
        display_name    text NOT NULL,
        data_type       text NOT NULL,
        nullable        boolean NOT NULL DEFAULT true,
        is_primary_key  boolean NOT NULL DEFAULT false,
        property_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (object_type_rid, api_name)
      )
    `);
    console.log("  [ok] B8 Step 29: object_type_properties");

    // === B8 Step 30 (B8.04): object_type_datasources ====================
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_datasources (
        object_type_rid text NOT NULL REFERENCES object_types(rid) ON DELETE CASCADE,
        datasource_rid  text NOT NULL,
        primary_key_columns text[] NOT NULL DEFAULT '{}',
        property_mapping    jsonb  NOT NULL DEFAULT '{}'::jsonb,
        is_primary       boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (object_type_rid, datasource_rid)
      )
    `);
    console.log("  [ok] B8 Step 30: object_type_datasources");

    // === B8 Step 31 (B8.05): link_types =================================
    await client.query(`
      CREATE TABLE IF NOT EXISTS link_types (
        rid              text PRIMARY KEY,
        ontology_rid     text NOT NULL REFERENCES ontologies(rid) ON DELETE CASCADE,
        branch_rid       text,
        api_name         text NOT NULL,
        display_name     text NOT NULL,
        backing_type     text NOT NULL CHECK (backing_type IN ('FOREIGN_KEY','JOIN_TABLE','OBJECT_BACKED')),
        cardinality      text NOT NULL CHECK (cardinality IN ('ONE_TO_ONE','ONE_TO_MANY','MANY_TO_ONE','MANY_TO_MANY')),
        a_object_type_rid text NOT NULL,
        b_object_type_rid text NOT NULL,
        config           jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      ALTER TABLE link_types DROP CONSTRAINT IF EXISTS link_types_ontology_rid_branch_rid_api_name_key
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS link_types_unique_idx
        ON link_types (ontology_rid, COALESCE(branch_rid, '__main__'), api_name)
    `);
    // B8.12 — extend link_types with status/etag/created_by columns.
    await client.query(`
      ALTER TABLE link_types
        ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'EXPERIMENTAL',
        ADD COLUMN IF NOT EXISTS etag       integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS created_by uuid
    `);
    await client.query(`
      ALTER TABLE link_types DROP CONSTRAINT IF EXISTS link_types_status_check
    `);
    await client.query(`
      ALTER TABLE link_types ADD CONSTRAINT link_types_status_check
        CHECK (status IN ('EXPERIMENTAL','ACTIVE','DEPRECATED'))
    `);
    console.log("  [ok] B8 Step 31: link_types (with B8.12 status/etag)");

    // === B8 Step 32 (B8.06): shared_property_types + interfaces ========
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_property_types (
        rid              text PRIMARY KEY,
        ontology_rid     text NOT NULL REFERENCES ontologies(rid) ON DELETE CASCADE,
        api_name         text NOT NULL,
        display_name     text NOT NULL,
        data_type        text NOT NULL,
        UNIQUE (ontology_rid, api_name)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS interfaces (
        rid              text PRIMARY KEY,
        ontology_rid     text NOT NULL REFERENCES ontologies(rid) ON DELETE CASCADE,
        api_name         text NOT NULL,
        display_name     text NOT NULL,
        properties       text[] NOT NULL DEFAULT '{}',
        UNIQUE (ontology_rid, api_name)
      )
    `);
    console.log("  [ok] B8 Step 32: shared_property_types + interfaces");

    // === B9 Step 40 (B9.01): funnel_b9_state ==========================
    // Note: a legacy table named `funnel_pipeline_state` already exists
    // with an unrelated schema; we use `funnel_b9_state` here to avoid
    // collision while preserving the v2 §B9 contract.
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_b9_state (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_rid  text NOT NULL,
        ontology_rid     text NOT NULL,
        branch_rid       text,
        phase            text NOT NULL CHECK (phase IN ('IDLE','CHANGELOG','MERGE_CHANGES','INDEXER','HYDRATOR','REPLACEMENT','ERROR')),
        last_run_at      timestamptz,
        next_run_at      timestamptz,
        last_offset      bigint NOT NULL DEFAULT 0,
        last_error       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS funnel_b9_state_unique_idx
        ON funnel_b9_state (object_type_rid, COALESCE(branch_rid, '__main__'))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS funnel_b9_state_phase_idx
        ON funnel_b9_state (phase)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS funnel_b9_state_next_run_idx
        ON funnel_b9_state (next_run_at NULLS LAST)
    `);
    console.log("  [ok] B9 Step 40: funnel_b9_state");

    await client.query("COMMIT");
    console.log("\nFoundry migration complete — all tables created successfully.");

    // ------------------------------------------------------------------
    // Forward SQL migration scan (deferred tail).
    //
    // src/migrate.ts runs BEFORE this file and applies the numbered SQL
    // migrations, but it must DEFER any migration whose dependency tables
    // are created here (resources, foundry_datasets, pipeline_nodes, …) —
    // e.g. the connectivity batch (074+). Now that those tables exist, we
    // apply every ledger-missing forward migration. Idempotent: the shared
    // schema_migrations_applied ledger means already-applied files are
    // skipped, and each file runs in its own transaction. A failure here is
    // fatal (re-thrown) so a genuinely broken migration still surfaces.
    // ------------------------------------------------------------------
    const fsMod = await import("fs");
    const pathMod = await import("path");
    const migrationsDir = pathMod.join(__dirname, "migrations");
    const ledgerExists = (
      await client.query(
        `SELECT to_regclass('public.schema_migrations_applied') IS NOT NULL AS exists`
      )
    ).rows[0].exists;

    if (ledgerExists && fsMod.existsSync(migrationsDir)) {
      const applied = await client.query<{ migration_name: string }>(
        "SELECT migration_name FROM schema_migrations_applied"
      );
      const appliedSet = new Set(applied.rows.map((r) => r.migration_name));

      const pending = fsMod
        .readdirSync(migrationsDir)
        .filter((f: string) => f.endsWith(".sql"))
        .filter((f: string) => !f.endsWith(".down.sql"))
        .filter((f: string) => {
          const m = /^(\d{3})_/.exec(f);
          if (!m) return false;
          return parseInt(m[1], 10) >= 33;
        })
        .filter((f: string) => !appliedSet.has(f))
        .sort();

      for (const fname of pending) {
        const fpath = pathMod.join(migrationsDir, fname);
        const sql = fsMod.readFileSync(fpath, "utf-8");
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            "INSERT INTO schema_migrations_applied(migration_name, applied_at) VALUES ($1, now()) ON CONFLICT DO NOTHING",
            [fname]
          );
          await client.query("COMMIT");
          console.log(`Applied (deferred tail) ${fname}`);
        } catch (migErr) {
          await client.query("ROLLBACK").catch(() => {});
          const msg = migErr instanceof Error ? migErr.message : String(migErr);
          throw new Error(`${fname} failed: ${msg}`);
        }
      }
    }
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
