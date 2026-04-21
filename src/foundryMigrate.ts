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
