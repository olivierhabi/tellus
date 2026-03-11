import "dotenv/config";
import { pool } from "./db";
import { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Complete migration order (all tables):
// Week 1: ontology, object_type, property, backing_datasource, funnel_state
// Future: link_type, link_join_table, action_type, ontology_edit,
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

    await client.query("COMMIT");
    console.log(
      "Migration complete. Tables: ontology, object_type, property, backing_datasource, funnel_state"
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
