import "dotenv/config";
import { pool } from "./db";
import { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Complete migration order (all tables):
// Week 1: ontology, object_type, property, backing_datasource, funnel_state
// Week 2: funnel_pipeline_state
// Week 3: ontology_edit
// Future: link_join_table, action_type,
//         action_audit_log, interface, object_type_interface
// ---------------------------------------------------------------------------

/**
 * Check whether a table already exists in the current database.
 */
async function tableExists(
  client: PoolClient,
  tableName: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return result.rows[0].exists;
}

/**
 * Log whether a table was freshly created or already existed.
 */
function logTableStatus(tableName: string, alreadyExisted: boolean): void {
  if (alreadyExisted) {
    console.log(`Table already exists: ${tableName}`);
  } else {
    console.log(`Created table: ${tableName}`);
  }
}

/**
 * Check whether a named constraint already exists in the database.
 */
async function constraintExists(
  client: PoolClient,
  constraintName: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = $1
     ) AS exists`,
    [constraintName]
  );
  return result.rows[0].exists;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ------------------------------------------------------------------
    // ontology
    // ------------------------------------------------------------------
    const ontologyExisted = await tableExists(client, "ontology");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology (
        ontology_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        display_name  TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
        description   TEXT,
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now(),
        created_by    TEXT        DEFAULT 'system'
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ontology_display_name
        ON ontology(display_name);
    `);

    logTableStatus("ontology", ontologyExisted);

    // ------------------------------------------------------------------
    // object_type
    // ------------------------------------------------------------------
    const objectTypeExisted = await tableExists(client, "object_type");

    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type (
        object_type_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id              UUID        NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name                 TEXT        NOT NULL,
        display_name             TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
        description              TEXT,
        icon                     TEXT        DEFAULT 'cube',
        icon_color               TEXT        DEFAULT '#1565C0',
        primary_key_property_id  UUID,
        title_property_id        UUID,
        status                   TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'experimental', 'deprecated')),
        edits_via_actions_only   BOOLEAN     DEFAULT true,
        max_properties           INTEGER     DEFAULT 2000,
        created_at               TIMESTAMPTZ DEFAULT now(),
        updated_at               TIMESTAMPTZ DEFAULT now(),
        created_by               TEXT        DEFAULT 'system',
        UNIQUE(ontology_id, api_name)
      );
    `);

    // Fast lookup of all object types belonging to a given ontology.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_type_ontology
        ON object_type(ontology_id);
    `);

    logTableStatus("object_type", objectTypeExisted);

    // ------------------------------------------------------------------
    // property
    // ------------------------------------------------------------------
    const propertyExisted = await tableExists(client, "property");

    await client.query(`
      CREATE TABLE IF NOT EXISTS property (
        property_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_id UUID        NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        api_name       TEXT        NOT NULL,
        display_name   TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
        description    TEXT,
        base_type      TEXT        NOT NULL CHECK (base_type IN (
          'string','boolean','integer','long','double','float','byte','short','decimal',
          'date','timestamp','geopoint','geoshape','struct',
          'string_array','integer_array','double_array','boolean_array','timestamp_array',
          'attachment','marking','media_reference','timeseries'
        )),
        struct_schema  JSONB,
        is_required    BOOLEAN     DEFAULT false,
        is_array       BOOLEAN     DEFAULT false,
        is_shared      BOOLEAN     DEFAULT false,
        ordinal        INTEGER     DEFAULT 0,
        UNIQUE(object_type_id, api_name)
      );
    `);

    // Fast lookup of all properties belonging to a given object type.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_property_object_type
        ON property(object_type_id);
    `);

    logTableStatus("property", propertyExisted);

    // ------------------------------------------------------------------
    // Deferred FK constraints: object_type -> property
    //
    // These could not be created in the object_type migration because
    // the property table did not exist yet. ON DELETE SET NULL means
    // deleting the referenced property nullifies the pointer rather
    // than cascade-deleting the object type.
    // ------------------------------------------------------------------
    const pkFkExisted = await constraintExists(client, "fk_ot_primary_key");
    if (!pkFkExisted) {
      await client.query(`
        ALTER TABLE object_type ADD CONSTRAINT fk_ot_primary_key
          FOREIGN KEY (primary_key_property_id)
          REFERENCES property(property_id) ON DELETE SET NULL;
      `);
      console.log("Added FK constraint: fk_ot_primary_key");
    } else {
      console.log("FK constraint already exists: fk_ot_primary_key");
    }

    const titleFkExisted = await constraintExists(client, "fk_ot_title_prop");
    if (!titleFkExisted) {
      await client.query(`
        ALTER TABLE object_type ADD CONSTRAINT fk_ot_title_prop
          FOREIGN KEY (title_property_id)
          REFERENCES property(property_id) ON DELETE SET NULL;
      `);
      console.log("Added FK constraint: fk_ot_title_prop");
    } else {
      console.log("FK constraint already exists: fk_ot_title_prop");
    }

    // ------------------------------------------------------------------
    // backing_datasource
    // ------------------------------------------------------------------
    const backingDsExisted = await tableExists(client, "backing_datasource");

    await client.query(`
      CREATE TABLE IF NOT EXISTS backing_datasource (
        mapping_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_id     UUID        NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        dataset_name       TEXT        NOT NULL,
        file_path          TEXT        NOT NULL,
        file_format        TEXT        NOT NULL DEFAULT 'csv' CHECK (file_format IN ('csv', 'json', 'parquet')),
        column_mapping     JSONB       NOT NULL,
        primary_key_column TEXT        NOT NULL,
        row_count          INTEGER,
        column_names       TEXT[],
        schema_hash        TEXT,
        last_scanned_at    TIMESTAMPTZ,
        registered_at      TIMESTAMPTZ DEFAULT now(),
        registered_by      TEXT        DEFAULT 'system'
      );
    `);

    // Palantir's one-datasource-per-object-type rule: each object type
    // can have at most one backing datasource.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_object_type
        ON backing_datasource(object_type_id);
    `);

    // Each file can back at most one object type.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ds_file_path
        ON backing_datasource(file_path);
    `);

    logTableStatus("backing_datasource", backingDsExisted);

    // ------------------------------------------------------------------
    // funnel_state
    //
    // Tracks the indexing state of each object type, modelling a
    // simplified version of Palantir's Object Indexing pipeline.
    //
    // State machine transitions:
    //   not_indexed -> indexing   (indexing starts)
    //   indexing    -> indexed    (indexing completes successfully)
    //   indexing    -> failed     (indexing encounters an error)
    //   indexed     -> stale      (datasource updated/replaced)
    //   stale       -> indexing   (re-indexing starts)
    //   failed      -> not_indexed (datasource re-registered)
    // ------------------------------------------------------------------
    const funnelStateExisted = await tableExists(client, "funnel_state");

    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_state (
        funnel_state_id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_id               UUID        NOT NULL UNIQUE REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        status                       TEXT        NOT NULL DEFAULT 'not_indexed' CHECK (status IN ('not_indexed', 'indexing', 'indexed', 'failed', 'stale')),
        objects_indexed              INTEGER     DEFAULT 0,
        objects_failed               INTEGER     DEFAULT 0,
        edits_pending                INTEGER     DEFAULT 0,
        last_indexed_at              TIMESTAMPTZ,
        last_index_duration_ms       INTEGER,
        last_datasource_modified_at  TIMESTAMPTZ,
        error_message                TEXT,
        error_count                  INTEGER     DEFAULT 0,
        index_name                   TEXT,
        created_at                   TIMESTAMPTZ DEFAULT now(),
        updated_at                   TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_state_object_type
        ON funnel_state(object_type_id);
    `);

    logTableStatus("funnel_state", funnelStateExisted);

    // ------------------------------------------------------------------
    // funnel_pipeline_state
    //
    // Detailed pipeline execution metrics for the indexing engine.
    // Coexists with `funnel_state` (which is the lightweight UI-facing
    // status). This table uses `object_type_api_name` as a TEXT PK
    // (not a UUID FK) because the indexing engine identifies object
    // types by API name throughout the pipeline.
    //
    // State machine:
    //   idle    -> running  (indexing starts)
    //   running -> success  (indexing completes)
    //   running -> failed   (indexing encounters error)
    //   success -> running  (re-indexing starts)
    //   failed  -> running  (retry)
    // ------------------------------------------------------------------
    const funnelPipelineStateExisted = await tableExists(
      client,
      "funnel_pipeline_state"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_pipeline_state (
        object_type_api_name  TEXT        PRIMARY KEY,
        status                TEXT        NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'success', 'failed')),
        last_indexed_at       TIMESTAMPTZ,
        objects_indexed       INT,
        duration_ms           INT,
        datasource_version    TEXT,
        error_message         TEXT,
        retry_count           INT         DEFAULT 0,
        created_at            TIMESTAMPTZ DEFAULT now(),
        updated_at            TIMESTAMPTZ DEFAULT now()
      );
    `);

    logTableStatus("funnel_pipeline_state", funnelPipelineStateExisted);

    // ------------------------------------------------------------------
    // link_type
    //
    // Defines relationships between object types. Each link type connects
    // a source object type to a target object type via foreign-key
    // properties. Cardinality determines resolution behavior.
    //
    // In Palantir's Ontology, Link Types are first-class resources that
    // define typed, directed edges between Object Types. The FK-based
    // approach mirrors how Palantir resolves "backing links" from
    // datasource foreign keys.
    // ------------------------------------------------------------------
    const linkTypeExisted = await tableExists(client, "link_type");

    await client.query(`
      CREATE TABLE IF NOT EXISTS link_type (
        link_type_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id         UUID        NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name            TEXT        NOT NULL,
        display_name        TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 256),
        description         TEXT,
        cardinality         TEXT        NOT NULL CHECK (cardinality IN ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_ONE', 'MANY_TO_MANY')),
        source_object_type  UUID        NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        target_object_type  UUID        NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        source_property_id  UUID        REFERENCES property(property_id) ON DELETE SET NULL,
        target_property_id  UUID        REFERENCES property(property_id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ DEFAULT now(),
        updated_at          TIMESTAMPTZ DEFAULT now(),
        UNIQUE(ontology_id, api_name)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_type_ontology
        ON link_type(ontology_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_type_source
        ON link_type(source_object_type);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_type_target
        ON link_type(target_object_type);
    `);

    logTableStatus("link_type", linkTypeExisted);

    // ------------------------------------------------------------------
    // ontology_edit
    //
    // Stores user edits created by the Action execution engine. During
    // reindexing, the Edit Merger (Stage 6 of the indexing pipeline)
    // reads unindexed edits from this table and merges them with
    // datasource data — user edits always win over datasource values
    // for the same primary key.
    //
    // After successful indexing, the pipeline marks rows as indexed
    // so they are not re-applied on the next run (though persistent
    // update/create edits are always re-applied to prevent datasource
    // refreshes from overwriting user changes).
    // ------------------------------------------------------------------
    const ontologyEditExisted = await tableExists(client, "ontology_edit");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_edit (
        edit_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_api_name   TEXT        NOT NULL,
        primary_key            TEXT        NOT NULL,
        operation              TEXT        NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
        property_values        JSONB,
        executed_by            TEXT,
        executed_at            TIMESTAMPTZ DEFAULT now(),
        indexed                BOOLEAN     DEFAULT false,
        indexed_at             TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ontology_edit_object_type
        ON ontology_edit(object_type_api_name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ontology_edit_unindexed
        ON ontology_edit(indexed) WHERE indexed = false;
    `);

    logTableStatus("ontology_edit", ontologyEditExisted);

    await client.query("COMMIT");
    console.log(
      "Migration complete. Tables: ontology, object_type, property, backing_datasource, funnel_state, funnel_pipeline_state, link_type, ontology_edit"
    );
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof Error ? err.message : String(err);
    console.error("Migration failed:", message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(0);
}

migrate();
