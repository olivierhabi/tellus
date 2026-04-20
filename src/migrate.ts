import "dotenv/config";
import { pool } from "./db";
import { PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Complete migration order (all tables):
// Week 1: ontology, object_type, property, backing_datasource, funnel_state
// Week 2: funnel_pipeline_state
// Week 3: ontology_edit (base schema)
// Week 4: action_type, ontology_edit (extended with link_edits, execution_id, etc.)
// Week 4: action_audit_log
// Sunday: interface, interface_property, object_type_interface
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
        version                  INTEGER     NOT NULL DEFAULT 1,
        created_at               TIMESTAMPTZ DEFAULT now(),
        updated_at               TIMESTAMPTZ DEFAULT now(),
        created_by               TEXT        DEFAULT 'system',
        UNIQUE(ontology_id, api_name)
      );
    `);
    // Back-fill version column on pre-existing object_type rows (idempotent).
    await client.query(
      `ALTER TABLE object_type ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`
    );
    // Auto-increment trigger so UPDATEs always bump the ETag version.
    await client.query(`
      CREATE OR REPLACE FUNCTION bump_version_column() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
          NEW.version := OLD.version + 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_object_type_version ON object_type`);
    await client.query(`
      CREATE TRIGGER trg_object_type_version
        BEFORE UPDATE ON object_type
        FOR EACH ROW EXECUTE FUNCTION bump_version_column()
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

    // Add join_table_file_path and is_bidirectional columns if missing (Thursday enhancement)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'link_type' AND column_name = 'join_table_file_path') THEN
          ALTER TABLE link_type ADD COLUMN join_table_file_path TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'link_type' AND column_name = 'is_bidirectional') THEN
          ALTER TABLE link_type ADD COLUMN is_bidirectional BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'link_type' AND column_name = 'join_table_source_column') THEN
          ALTER TABLE link_type ADD COLUMN join_table_source_column TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'link_type' AND column_name = 'join_table_target_column') THEN
          ALTER TABLE link_type ADD COLUMN join_table_target_column TEXT;
        END IF;
      END
      $$;
    `);

    logTableStatus("link_type", linkTypeExisted);

    // ------------------------------------------------------------------
    // ontology_edit
    //
    // Write-ahead log for all Ontology object modifications made through
    // Actions. Each row represents a single create, update, or delete
    // operation on one object. Pending edits (indexed=false) are
    // processed by the indexer and merged with datasource data in
    // OpenSearch. Mirrors Palantir Object Storage V2 edit handling.
    //
    // Key behavior: when a backing datasource is reindexed, user edits
    // (from Actions) take precedence over datasource data for the same
    // primary key. The edit store is the source of truth for user
    // modifications.
    //
    // After successful indexing, the pipeline marks rows as indexed
    // so they are not re-applied on the next run (though persistent
    // update/create edits are always re-applied to prevent datasource
    // refreshes from overwriting user changes).
    // ------------------------------------------------------------------
    const ontologyEditExisted = await tableExists(client, "ontology_edit");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_edit (
        edit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- Which object type this edit targets. Stored as the api_name string
        -- rather than a foreign key, because we need to be able to process
        -- edits even if the object type schema changes between when the edit
        -- was created and when it's indexed.
        object_type_api_name TEXT NOT NULL,

        -- The primary key of the specific object being edited.
        primary_key TEXT NOT NULL,

        -- The type of edit operation: 'create', 'update', or 'delete'.
        operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),

        -- The property values being set by this edit. JSON object where keys
        -- are property api_names and values are the new values.
        property_values JSONB DEFAULT '{}'::jsonb,

        -- Link edits associated with this object edit. JSON array of link
        -- operations: { linkTypeApiName, targetPrimaryKey, operation: add|remove }
        link_edits JSONB DEFAULT '[]'::jsonb,

        -- Which action type produced this edit (api_name for traceability).
        action_type_api_name TEXT,

        -- Groups all edits from a single action execution together.
        execution_id UUID,

        -- Snapshot of parameters passed to the action when this edit was produced.
        action_parameters JSONB DEFAULT '{}'::jsonb,

        -- Who executed the action that produced this edit.
        executed_by TEXT NOT NULL DEFAULT 'system',

        -- When this edit was created (not when it was indexed).
        executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- Whether this edit has been indexed into OpenSearch.
        indexed BOOLEAN NOT NULL DEFAULT false,

        -- When the edit was indexed into OpenSearch. NULL until indexed.
        indexed_at TIMESTAMPTZ DEFAULT NULL,

        -- The branch this edit belongs to. NULL means the Main branch.
        branch_id UUID DEFAULT NULL
      );
    `);

    // Add new columns to existing table if they don't exist yet
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_edit' AND column_name = 'link_edits') THEN
          ALTER TABLE ontology_edit ADD COLUMN link_edits JSONB DEFAULT '[]'::jsonb;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_edit' AND column_name = 'action_type_api_name') THEN
          ALTER TABLE ontology_edit ADD COLUMN action_type_api_name TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_edit' AND column_name = 'execution_id') THEN
          ALTER TABLE ontology_edit ADD COLUMN execution_id UUID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_edit' AND column_name = 'action_parameters') THEN
          ALTER TABLE ontology_edit ADD COLUMN action_parameters JSONB DEFAULT '{}'::jsonb;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ontology_edit' AND column_name = 'branch_id') THEN
          ALTER TABLE ontology_edit ADD COLUMN branch_id UUID DEFAULT NULL;
        END IF;
      END
      $$;
    `);

    // Update column defaults/constraints on existing table to match new schema
    // (executed_by: NOT NULL DEFAULT 'system', executed_at: NOT NULL, indexed: NOT NULL)
    await client.query(`
      DO $$
      BEGIN
        -- Backfill any NULL executed_by values before making NOT NULL
        UPDATE ontology_edit SET executed_by = 'system' WHERE executed_by IS NULL;
        -- Alter executed_by to NOT NULL with default
        ALTER TABLE ontology_edit ALTER COLUMN executed_by SET NOT NULL;
        ALTER TABLE ontology_edit ALTER COLUMN executed_by SET DEFAULT 'system';
        -- Alter executed_at to NOT NULL
        ALTER TABLE ontology_edit ALTER COLUMN executed_at SET NOT NULL;
        ALTER TABLE ontology_edit ALTER COLUMN executed_at SET DEFAULT now();
        -- Alter indexed to NOT NULL
        ALTER TABLE ontology_edit ALTER COLUMN indexed SET NOT NULL;
        ALTER TABLE ontology_edit ALTER COLUMN indexed SET DEFAULT false;
        -- Update property_values default
        ALTER TABLE ontology_edit ALTER COLUMN property_values SET DEFAULT '{}'::jsonb;
      EXCEPTION
        WHEN others THEN
          -- Ignore errors if constraints already set
          NULL;
      END
      $$;
    `);

    // Index for the most critical query: "get all pending edits for an object type"
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_pending
        ON ontology_edit(object_type_api_name, indexed)
        WHERE indexed = false;
    `);

    // Index for looking up all edits for a specific object (edit history)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_object
        ON ontology_edit(object_type_api_name, primary_key, executed_at DESC);
    `);

    // Index for looking up all edits from a specific action execution
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_execution
        ON ontology_edit(execution_id);
    `);

    // Index for looking up edits by the user who made them
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_user
        ON ontology_edit(executed_by, executed_at DESC);
    `);

    // Keep legacy indexes for backward compatibility
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ontology_edit_object_type
        ON ontology_edit(object_type_api_name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ontology_edit_unindexed
        ON ontology_edit(indexed) WHERE indexed = false;
    `);

    await client.query(`
      COMMENT ON TABLE ontology_edit IS 'Write-ahead log for all Ontology object modifications made through Actions. Each row represents a single create, update, or delete operation on one object. Pending edits (indexed=false) are processed by the indexer and merged with datasource data in OpenSearch. Mirrors Palantir Object Storage V2 edit handling.';
    `);

    logTableStatus("ontology_edit", ontologyEditExisted);

    // ------------------------------------------------------------------
    // action_type
    //
    // Stores action type definitions for the Ontology. Each action type
    // defines a parameterized, auditable set of changes that can be
    // applied to objects, properties, and links. Mirrors Palantir Foundry
    // action type schema.
    //
    // An action type has:
    //   - parameters: JSON array of input definitions the caller must provide
    //   - rules: JSON array of edit rules (createObject, modifyObject, etc.)
    //   - submission_criteria: who can execute the action (null = anyone)
    //   - side_effects: webhooks/notifications after execution (null = none)
    // ------------------------------------------------------------------
    const actionTypeExisted = await tableExists(client, "action_type");

    await client.query(`
      CREATE TABLE IF NOT EXISTS action_type (
        action_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT DEFAULT '',

        -- Parameters: defines the inputs the caller must provide when executing this action.
        -- This is a JSON array of parameter definition objects. Each parameter has:
        --   apiName (string, required): The machine-readable name used in API calls, e.g., "employeeId"
        --   displayName (string, required): The human-readable label shown in UIs, e.g., "Employee ID"
        --   type (string, required): The data type of the parameter. Must be one of:
        --     'string', 'boolean', 'integer', 'long', 'double', 'float', 'date', 'timestamp',
        --     'object_reference' (a primary key of an existing object),
        --     'object_set' (a filter that resolves to a set of objects),
        --     'string_array', 'integer_array', 'double_array',
        --     'struct' (a nested JSON object with a defined schema)
        --   required (boolean, default false): Whether the parameter must be provided
        --   objectType (string, optional): For 'object_reference' and 'object_set' types, specifies which object type
        --   defaultValue (any, optional): The default value if the parameter is not provided
        --   constraints (object, optional): Validation constraints like { "regex": "^EMP-\\d{6}$", "min": 0, "max": 1000000 }
        parameters JSONB NOT NULL DEFAULT '[]'::jsonb,

        -- Rules: defines the logic that transforms parameters into Ontology edits.
        -- This is a JSON array of rule objects. Each rule has a "type" field and type-specific fields.
        -- Supported rule types (from Palantir docs):
        --   "createObject": Creates a new object of a specified type
        --   "modifyObject": Modifies properties on one or more existing objects
        --   "deleteObject": Deletes one or more existing objects
        --   "addLink": Creates a many-to-many link between two objects
        --   "removeLink": Removes a many-to-many link between two objects
        -- When multiple rules exist, Palantir's backend "compiles rules to generate a single edit per object"
        -- This means if Rule A sets property X to "A" and Rule B sets property X to "B" on the same object,
        -- the final result is property X = "B" (last rule wins).
        rules JSONB NOT NULL DEFAULT '[]'::jsonb,

        -- Submission criteria: defines who can execute this action.
        -- For week 1, this will be null (anyone can execute any action).
        -- In production, this would contain conditions like:
        --   { "type": "userInGroup", "groupId": "tax-auditors" }
        --   { "type": "parameterCondition", "param": "amount", "operator": "lt", "value": 10000 }
        submission_criteria JSONB DEFAULT NULL,

        -- Side effects: webhooks and notifications triggered after successful execution.
        -- For week 1, this will be null (no side effects).
        -- Structure when implemented:
        --   { "webhooks": [...], "notifications": [...] }
        side_effects JSONB DEFAULT NULL,

        -- Maximum number of objects that can be affected by a single execution of this action.
        -- Palantir default is 10,000. If an action would affect more objects, it fails with a "scale limit failure".
        -- This is documented in Palantir's Action Metrics page under failure types.
        max_affected_objects INTEGER NOT NULL DEFAULT 10000,

        -- Whether this action is enabled. Disabled actions cannot be executed but remain in the schema.
        is_enabled BOOLEAN NOT NULL DEFAULT true,

        -- Timestamps for audit and management purposes
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT DEFAULT 'system',

        -- Ensure action type API names are unique within an ontology.
        -- Just as you cannot have two object types with the same api_name, you cannot have two action types
        -- with the same api_name in the same ontology.
        CONSTRAINT uq_action_type_api_name UNIQUE (ontology_id, api_name)
      );
    `);

    // Create indexes for common query patterns
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_action_type_ontology ON action_type(ontology_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_action_type_api_name ON action_type(api_name);
    `);

    await client.query(`
      COMMENT ON TABLE action_type IS 'Stores action type definitions for the Ontology. Each action type defines a parameterized, auditable set of changes that can be applied to objects, properties, and links. Mirrors Palantir Foundry action type schema.';
    `);

    logTableStatus("action_type", actionTypeExisted);

    // ------------------------------------------------------------------
    // action_audit_log
    //
    // Immutable audit log for all action execution attempts. Records
    // every action execution with full parameter snapshots, affected
    // objects, results, and timing. Once written, rows cannot be
    // modified or deleted. Mirrors Palantir action audit system.
    //
    // Failure types tracked (from Palantir Action Metrics docs):
    //   - invalid_parameter: submitted with invalid parameters
    //   - scale_limit: affected more than max_affected_objects
    //   - authentication: user failed security submission criteria
    //   - object_not_found: modify/delete referenced nonexistent object
    //   - duplicate_primary_key: create with existing PK
    //   - required_property_missing: create missing required property
    //   - type_mismatch: parameter/property value type mismatch
    //   - side_effect: webhook/notification failure
    //   - function_failure: function-backed action failure (future)
    //   - unclassified: any other failure
    // ------------------------------------------------------------------
    const auditLogExisted = await tableExists(client, "action_audit_log");

    await client.query(`
      CREATE TABLE IF NOT EXISTS action_audit_log (
        audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        -- The action type that was executed (or attempted). Stored as api_name.
        action_type_api_name TEXT NOT NULL,

        -- The display name of the action type at the time of execution.
        -- Stored separately because the action type might be renamed later.
        action_type_display_name TEXT NOT NULL,

        -- A unique identifier for this specific execution attempt.
        -- Links to ontology_edit.execution_id for traceability.
        execution_id UUID NOT NULL UNIQUE,

        -- The full set of parameters passed to the action.
        parameters JSONB NOT NULL DEFAULT '{}'::jsonb,

        -- The list of objects affected by this execution.
        affected_objects JSONB NOT NULL DEFAULT '[]'::jsonb,

        -- The number of objects affected.
        affected_object_count INTEGER NOT NULL DEFAULT 0,

        -- The result of the execution: 'success', 'failed', or 'partial'.
        result TEXT NOT NULL CHECK (result IN ('success', 'failed', 'partial')),

        -- The type of failure, if result is 'failed'.
        failure_type TEXT CHECK (failure_type IN (
          'invalid_parameter', 'scale_limit', 'authentication',
          'object_not_found', 'duplicate_primary_key', 'required_property_missing',
          'type_mismatch', 'side_effect', 'function_failure', 'unclassified'
        )),

        -- Human-readable error message describing why the action failed.
        error_message TEXT,

        -- How long the action took to execute, in milliseconds.
        duration_ms INTEGER NOT NULL DEFAULT 0,

        -- Who executed the action.
        executed_by TEXT NOT NULL DEFAULT 'system',

        -- When the action was executed.
        executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

        -- The branch this action was executed on. NULL = Main branch.
        branch_id UUID DEFAULT NULL,

        -- IP address of the caller, if available.
        source_ip TEXT,

        -- Additional metadata for debugging or analytics.
        metadata JSONB DEFAULT '{}'::jsonb
      );
    `);

    // Index for querying audit logs by action type
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_action_type
        ON action_audit_log(action_type_api_name, executed_at DESC);
    `);

    // Index for querying audit logs by user
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_user
        ON action_audit_log(executed_by, executed_at DESC);
    `);

    // Index for querying by result
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_result
        ON action_audit_log(result, executed_at DESC);
    `);

    // Index for time-range queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_time
        ON action_audit_log(executed_at DESC);
    `);

    await client.query(`
      COMMENT ON TABLE action_audit_log IS 'Immutable audit log for all action execution attempts. Records every action execution with full parameter snapshots, affected objects, results, and timing. Once written, rows cannot be modified or deleted. Mirrors Palantir action audit system.';
    `);

    logTableStatus("action_audit_log", auditLogExisted);

    // ------------------------------------------------------------------
    // Table 11: link_edit
    //
    // Stores individual link operations (add/remove) for many-to-many
    // link types. Each row represents a single link add or remove
    // operation produced by an action execution. FK-based links
    // (ONE_TO_MANY, MANY_TO_ONE) are handled as property updates on the
    // ontology_edit table instead.
    // ------------------------------------------------------------------
    const linkEditExisted = (
      await client.query(
        "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'link_edit') AS exists"
      )
    ).rows[0].exists;

    await client.query(`
      CREATE TABLE IF NOT EXISTS link_edit (
        link_edit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        link_type_api_name TEXT NOT NULL,
        source_primary_key TEXT NOT NULL,
        target_primary_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('add', 'remove')),
        execution_id UUID,
        executed_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_edit_execution
        ON link_edit(execution_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_edit_link_type
        ON link_edit(link_type_api_name);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_link_edit_source
        ON link_edit(source_primary_key);
    `);

    await client.query(`
      COMMENT ON TABLE link_edit IS 'Stores individual link add/remove operations for many-to-many link types. Each row represents a single link operation produced by an action execution. Mirrors Palantir link edit tracking in the Object Storage V2 edit store.';
    `);

    logTableStatus("link_edit", linkEditExisted);

    // ------------------------------------------------------------------
    // TABLE 12: idempotency_key (Task 21)
    //
    // Tracks idempotency keys for action execution. When a client includes
    // an Idempotency-Key header, the server checks this table before
    // executing. If a matching key exists (and is not expired), the cached
    // result is returned instead of re-executing the action.
    //
    // Keys expire after 24 hours to prevent unbounded table growth.
    // ------------------------------------------------------------------
    const idempotencyKeyExisted = await tableExists(client, "idempotency_key");

    await client.query(`
      CREATE TABLE IF NOT EXISTS idempotency_key (
        idempotency_key   TEXT        PRIMARY KEY,
        action_type_api_name TEXT     NOT NULL,
        execution_id      UUID        NOT NULL,
        result            JSONB       NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry
        ON idempotency_key(expires_at);
    `);

    await client.query(`
      COMMENT ON TABLE idempotency_key IS 'Stores cached action execution results keyed by client-provided idempotency keys. Prevents duplicate action execution on client retries. Keys expire after 24 hours.';
    `);

    logTableStatus("idempotency_key", idempotencyKeyExisted);

    // ------------------------------------------------------------------
    // dataset
    //
    // Stores metadata for uploaded datasets. Each dataset represents a
    // file (CSV, JSON, JSONL) that can be used as a backing datasource
    // for object types. Supports transactional writes via the
    // dataset_transaction table.
    // ------------------------------------------------------------------
    const datasetExisted = await tableExists(client, "dataset");

    await client.query(`
      CREATE TABLE IF NOT EXISTS dataset (
        dataset_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT,
        file_format TEXT NOT NULL CHECK (file_format IN ('csv', 'json', 'jsonl')),
        schema_definition JSONB,
        storage_path TEXT,
        total_rows INTEGER DEFAULT 0,
        total_size_bytes BIGINT DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT NOT NULL DEFAULT 'system'
      );
    `);

    // Add created_by column if missing (for existing installations)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'dataset' AND column_name = 'created_by') THEN
          ALTER TABLE dataset ADD COLUMN created_by TEXT NOT NULL DEFAULT 'system';
        END IF;
      END
      $$;
    `);

    logTableStatus("dataset", datasetExisted);

    // ------------------------------------------------------------------
    // dataset_transaction
    //
    // Tracks individual file upload transactions for a dataset. Each
    // upload creates a transaction that moves through the lifecycle:
    // open -> committed (or failed/aborted). Supports SNAPSHOT (full
    // replacement) and APPEND (additive) transaction types.
    // ------------------------------------------------------------------
    const datasetTransactionExisted = await tableExists(
      client,
      "dataset_transaction"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS dataset_transaction (
        transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id UUID NOT NULL REFERENCES dataset(dataset_id) ON DELETE CASCADE,
        transaction_type TEXT NOT NULL CHECK (transaction_type IN ('SNAPSHOT', 'APPEND')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'failed', 'aborted')),
        file_path TEXT,
        file_name TEXT,
        file_size_bytes BIGINT DEFAULT 0,
        row_count INTEGER DEFAULT 0,
        schema_definition JSONB,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        committed_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dataset_transaction_dataset_id
        ON dataset_transaction(dataset_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dataset_transaction_status
        ON dataset_transaction(status);
    `);

    logTableStatus("dataset_transaction", datasetTransactionExisted);

    // ------------------------------------------------------------------
    // backing_datasource: add dataset_id column if missing
    //
    // Links a backing datasource to a dataset, enabling the datasource
    // to reference uploaded dataset files rather than only local files.
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'backing_datasource' AND column_name = 'dataset_id') THEN
          ALTER TABLE backing_datasource ADD COLUMN dataset_id UUID REFERENCES dataset(dataset_id);
        END IF;
      END
      $$;
    `);

    console.log("Ensured backing_datasource has dataset_id column");

    // ------------------------------------------------------------------
    // object_type: add Palantir-parity metadata columns if missing.
    //
    // The overview tab surfaces a pile of curatorial metadata — plural
    // name, aliases, point of contact, contributors, visibility — that
    // wasn't part of the v1 schema. Added here as idempotent ALTERs so
    // existing deployments upgrade cleanly without a bespoke migration.
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'plural_name') THEN
          ALTER TABLE object_type ADD COLUMN plural_name TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'aliases') THEN
          ALTER TABLE object_type ADD COLUMN aliases TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'point_of_contact') THEN
          ALTER TABLE object_type ADD COLUMN point_of_contact TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'contributors') THEN
          ALTER TABLE object_type ADD COLUMN contributors TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'visibility') THEN
          ALTER TABLE object_type ADD COLUMN visibility TEXT NOT NULL DEFAULT 'normal'
            CHECK (visibility IN ('prominent','normal','hidden'));
        END IF;
        -- When a caller creates an object type with an apiName that
        -- already exists in this ontology AND opts into the rename-
        -- on-conflict strategy, we keep a record of the ORIGINAL
        -- apiName the caller asked for. The overview page reads this
        -- and surfaces a red "Invalid" badge so the user can fix it.
        -- Cleared by the update service whenever a rename lands.
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type' AND column_name = 'requested_api_name') THEN
          ALTER TABLE object_type ADD COLUMN requested_api_name TEXT;
        END IF;
      END
      $$;
    `);
    console.log("Ensured object_type has curatorial metadata columns");

    // ------------------------------------------------------------------
    // funnel_pipeline_state: add per-stage progress tracking.
    //
    // Spec (ontology-object explorer.md §1.7, item 47) calls for a
    // 4-stage Funnel pipeline — `changelog → merge_changes → indexing
    // → hydration`. The original schema only tracked the top-level
    // `status` (idle/running/success/failed). To surface which stage
    // is live in the overview card's spinner, we add:
    //
    //   current_stage    — null when idle/success/failed, else one
    //                      of the 4 stage names
    //   stage_started_at — UTC timestamp at which the live stage
    //                      entered 'running', so the frontend can
    //                      compute "X s elapsed" without pulling a
    //                      full history row.
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'funnel_pipeline_state' AND column_name = 'current_stage') THEN
          ALTER TABLE funnel_pipeline_state
            ADD COLUMN current_stage TEXT
              CHECK (current_stage IS NULL OR current_stage IN ('changelog','merge_changes','indexing','hydration'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'funnel_pipeline_state' AND column_name = 'stage_started_at') THEN
          ALTER TABLE funnel_pipeline_state ADD COLUMN stage_started_at TIMESTAMPTZ;
        END IF;
      END
      $$;
    `);
    console.log("Ensured funnel_pipeline_state has stage tracking columns");

    // ------------------------------------------------------------------
    // reindex_history
    //
    // Audit log for re-indexing operations. Each row records a single
    // reindex execution for an object type, including timing, counts,
    // and error information. Used for monitoring and debugging the
    // indexing pipeline.
    // ------------------------------------------------------------------
    const reindexHistoryExisted = await tableExists(client, "reindex_history");

    await client.query(`
      CREATE TABLE IF NOT EXISTS reindex_history (
        reindex_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_api_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
        triggered_by TEXT NOT NULL DEFAULT 'manual',
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER,
        transactions_processed INTEGER DEFAULT 0,
        objects_from_datasource INTEGER DEFAULT 0,
        edits_applied INTEGER DEFAULT 0,
        total_objects_indexed INTEGER DEFAULT 0,
        error_message TEXT,
        metadata JSONB DEFAULT '{}'
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reindex_history_object_type
        ON reindex_history(object_type_api_name);
    `);

    logTableStatus("reindex_history", reindexHistoryExisted);

    // ------------------------------------------------------------------
    // interface
    //
    // Defines shared property contracts that Object Types can implement.
    // An Interface declares a set of typed properties. When an Object
    // Type implements an Interface, it maps its own properties to the
    // Interface's properties, enabling polymorphic queries across
    // heterogeneous Object Types. Mirrors Palantir Foundry's Interface
    // system for cross-object-type abstraction.
    //
    // api_name must be PascalCase (same as Object Type naming) and
    // globally unique across both Interfaces and Object Types within
    // the same ontology to prevent naming collisions.
    // ------------------------------------------------------------------
    const interfaceExisted = await tableExists(client, "interface");

    await client.query(`
      CREATE TABLE IF NOT EXISTS interface (
        interface_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name TEXT NOT NULL UNIQUE CHECK (api_name ~ '^[A-Z][a-zA-Z0-9]*$'),
        display_name TEXT NOT NULL,
        description TEXT,
        parent_interface_id UUID REFERENCES interface(interface_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Back-fill parent_interface_id column on pre-existing interface rows.
    await client.query(
      `ALTER TABLE interface ADD COLUMN IF NOT EXISTS parent_interface_id UUID REFERENCES interface(interface_id) ON DELETE SET NULL`
    );

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_interface_ontology_id ON interface(ontology_id);
    `);

    logTableStatus("interface", interfaceExisted);

    // ------------------------------------------------------------------
    // interface_property
    //
    // Defines the individual typed properties that belong to an Interface.
    // Each property has a base_type from the standard Palantir type system.
    // Object Types that implement the Interface must map their own
    // properties to these Interface properties (via object_type_interface).
    //
    // api_name must be camelCase (same as Object Type property naming).
    // The (interface_id, api_name) pair is unique — no duplicate property
    // names within a single Interface.
    // ------------------------------------------------------------------
    const interfacePropertyExisted = await tableExists(
      client,
      "interface_property"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS interface_property (
        interface_property_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        interface_id UUID NOT NULL REFERENCES interface(interface_id) ON DELETE CASCADE,
        api_name TEXT NOT NULL CHECK (api_name ~ '^[a-z][a-zA-Z0-9]*$'),
        display_name TEXT NOT NULL,
        base_type TEXT NOT NULL CHECK (base_type IN (
          'string','boolean','integer','long','double','float','date','timestamp',
          'byte','short','decimal','geopoint','geoshape',
          'string_array','integer_array','long_array','double_array',
          'boolean_array','timestamp_array','struct'
        )),
        is_required BOOLEAN NOT NULL DEFAULT false,
        ordinal INTEGER NOT NULL DEFAULT 0,
        UNIQUE (interface_id, api_name)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_interface_property_interface_id
        ON interface_property(interface_id);
    `);

    logTableStatus("interface_property", interfacePropertyExisted);

    // ------------------------------------------------------------------
    // object_type_interface
    //
    // Junction table linking Object Types to the Interfaces they implement.
    // Each row maps one Object Type to one Interface, with a property_mapping
    // JSONB that records which Object Type property fulfills each Interface
    // property. Example property_mapping:
    //   { "employeeName": "fullName", "employeeId": "empId" }
    //   (Interface property -> Object Type property)
    //
    // ON DELETE RESTRICT on interface_id prevents accidental deletion of
    // Interfaces that are still implemented by Object Types. The Object
    // Type must explicitly un-implement the Interface first.
    // ------------------------------------------------------------------
    const objectTypeInterfaceExisted = await tableExists(
      client,
      "object_type_interface"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_interface (
        object_type_id UUID NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        interface_id UUID NOT NULL REFERENCES interface(interface_id) ON DELETE RESTRICT,
        property_mapping JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (object_type_id, interface_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_oti_interface_id
        ON object_type_interface(interface_id);
    `);

    logTableStatus("object_type_interface", objectTypeInterfaceExisted);

    await client.query("COMMIT");
    console.log(
      "Migration complete. Tables: ontology, object_type, property, backing_datasource, funnel_state, funnel_pipeline_state, link_type, ontology_edit, action_type, action_audit_log, link_edit, idempotency_key, dataset, dataset_transaction, reindex_history, interface, interface_property, object_type_interface"
    );

    // ------------------------------------------------------------------
    // Post-transaction: REVOKE UPDATE/DELETE on action_audit_log
    //
    // REVOKE runs outside the main transaction because it is a DCL
    // (Data Control Language) statement that takes effect immediately.
    // This makes the audit log truly immutable — only INSERT is allowed.
    // ------------------------------------------------------------------
    try {
      await client.query(
        "REVOKE UPDATE, DELETE ON action_audit_log FROM PUBLIC"
      );
      console.log("Revoked UPDATE/DELETE on action_audit_log (immutable audit log)");
    } catch (revokeErr) {
      // Non-fatal: the table is still functional without the REVOKE.
      // This may fail if the user doesn't have GRANT/REVOKE privileges.
      const msg = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
      console.warn("Warning: Could not REVOKE UPDATE/DELETE on action_audit_log:", msg);
    }

    // ------------------------------------------------------------------
    // Ontology Platform spec Phase 2 — branching, proposals, groups,
    // functions, markings, explorations, exports.
    // ------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_branch (
        branch_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id     UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','MERGED','CLOSED')),
        parent_branch_id UUID REFERENCES ontology_branch(branch_id) ON DELETE SET NULL,
        created_by      TEXT NOT NULL DEFAULT 'system',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        merged_at       TIMESTAMPTZ,
        UNIQUE (ontology_id, name)
      );
    `);
    // Pre-existing ontology_branch schemas may lack these columns — back-fill
    // defensively. If the CHECK constraint is missing, re-add it.
    await client.query(`ALTER TABLE ontology_branch ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'OPEN'`);
    await client.query(`ALTER TABLE ontology_branch ADD COLUMN IF NOT EXISTS parent_branch_id UUID`);
    await client.query(`ALTER TABLE ontology_branch ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'system'`);
    await client.query(`ALTER TABLE ontology_branch ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ontology_branch_ontology ON ontology_branch(ontology_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ontology_branch_status ON ontology_branch(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_proposal (
        proposal_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        branch_id       UUID NOT NULL REFERENCES ontology_branch(branch_id) ON DELETE CASCADE,
        title           TEXT NOT NULL,
        description     TEXT,
        status          TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','APPROVED','MERGED','CLOSED')),
        created_by      TEXT NOT NULL DEFAULT 'system',
        approved_by     TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        approved_at     TIMESTAMPTZ,
        merged_at       TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_branch ON ontology_proposal(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proposal_status ON ontology_proposal(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_group (
        group_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id  UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name     TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description  TEXT,
        icon         TEXT DEFAULT 'folder',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (ontology_id, api_name)
      );
    `);
    // Pre-existing schemas may have `name` instead of api_name/display_name.
    // Back-fill additively so both old and new code paths work.
    await client.query(`ALTER TABLE object_type_group ADD COLUMN IF NOT EXISTS api_name TEXT`);
    await client.query(`ALTER TABLE object_type_group ADD COLUMN IF NOT EXISTS display_name TEXT`);
    // Backfill api_name/display_name from legacy `name` column if it exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'object_type_group' AND column_name = 'name') THEN
          UPDATE object_type_group SET api_name = COALESCE(api_name, name), display_name = COALESCE(display_name, name) WHERE api_name IS NULL OR display_name IS NULL;
        END IF;
      END
      $$;
    `);
    await client.query(`ALTER TABLE object_type_group ALTER COLUMN api_name SET NOT NULL`);
    await client.query(`ALTER TABLE object_type_group ALTER COLUMN display_name SET NOT NULL`);
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'object_type_group_ontology_api_name_key') THEN
        BEGIN
          ALTER TABLE object_type_group ADD CONSTRAINT object_type_group_ontology_api_name_key UNIQUE (ontology_id, api_name);
        EXCEPTION WHEN duplicate_table THEN NULL; WHEN unique_violation THEN NULL; END;
      END IF;
    END $$;`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_group_member (
        group_id         UUID NOT NULL REFERENCES object_type_group(group_id) ON DELETE CASCADE,
        object_type_id   UUID NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, object_type_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_function (
        function_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id    UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        api_name       TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        description    TEXT,
        runtime        TEXT NOT NULL DEFAULT 'typescript'
                        CHECK (runtime IN ('typescript','python','sql')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (ontology_id, api_name)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_function_version (
        version_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        function_id    UUID NOT NULL REFERENCES ontology_function(function_id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL,
        source_code    TEXT NOT NULL,
        input_schema   JSONB DEFAULT '{}'::jsonb,
        output_schema  JSONB DEFAULT '{}'::jsonb,
        is_latest      BOOLEAN NOT NULL DEFAULT true,
        published_by   TEXT NOT NULL DEFAULT 'system',
        published_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (function_id, version_number)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ontology_function_invocation (
        invocation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        function_id    UUID NOT NULL REFERENCES ontology_function(function_id) ON DELETE CASCADE,
        version_id     UUID NOT NULL REFERENCES ontology_function_version(version_id) ON DELETE CASCADE,
        duration_ms    INTEGER,
        status         TEXT NOT NULL CHECK (status IN ('ok','error','timeout')),
        error_message  TEXT,
        invoked_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fn_invocation_function ON ontology_function_invocation(function_id, invoked_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_favorite (
        user_id      TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('objectType','linkType','actionType','interface','function','group')),
        resource_id  TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, resource_type, resource_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_recent_activity (
        id           BIGSERIAL PRIMARY KEY,
        user_id      TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id  TEXT NOT NULL,
        visited_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recent_user_time ON user_recent_activity(user_id, visited_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_exploration (
        exploration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id    UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        owner_id       TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT,
        config         JSONB NOT NULL DEFAULT '{}'::jsonb,
        visibility     TEXT NOT NULL DEFAULT 'private'
                        CHECK (visibility IN ('private','shared','public')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Back-fill columns on pre-existing saved_exploration schemas.
    await client.query(`ALTER TABLE saved_exploration ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'system'`);
    await client.query(`ALTER TABLE saved_exploration ADD COLUMN IF NOT EXISTS description TEXT`);
    await client.query(`ALTER TABLE saved_exploration ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE saved_exploration ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'`);
    await client.query(`ALTER TABLE saved_exploration ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS export_job (
        job_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id    UUID NOT NULL REFERENCES ontology(ontology_id) ON DELETE CASCADE,
        requested_by   TEXT NOT NULL,
        object_type_api_name TEXT,
        format         TEXT NOT NULL CHECK (format IN ('csv','xlsx','jsonl')),
        query_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
        status         TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','EXPIRED')),
        row_count      BIGINT,
        file_path      TEXT,
        download_url   TEXT,
        expires_at     TIMESTAMPTZ,
        error_message  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_export_job_status ON export_job(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS marking (
        marking_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code         TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description  TEXT,
        color        TEXT DEFAULT '#999999',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS marking_assignment (
        marking_id   UUID NOT NULL REFERENCES marking(marking_id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('user','group')),
        subject_id   TEXT NOT NULL,
        PRIMARY KEY (marking_id, subject_type, subject_id)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS organization (
        organization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code            TEXT NOT NULL UNIQUE,
        display_name    TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pii_scan_result (
        scan_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        object_type_id UUID NOT NULL REFERENCES object_type(object_type_id) ON DELETE CASCADE,
        property_api_name TEXT NOT NULL,
        detected_type TEXT NOT NULL,
        sample_count  INTEGER NOT NULL DEFAULT 0,
        scanned_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Spec §Task 30: usage materialized view refreshed every 60s.
    //   "SELECT object_type_id, date_trunc('day', timestamp) AS day,
    //    operation, COUNT(*) FROM usage_events WHERE timestamp > now() -
    //    interval '30 days' GROUP BY 1, 2, 3"
    await client.query(`
      DROP MATERIALIZED VIEW IF EXISTS usage_event_daily;
    `);
    try {
      await client.query(`
        CREATE MATERIALIZED VIEW usage_event_daily AS
        SELECT
          resource_type,
          resource_id,
          date_trunc('day', created_at) AS day,
          operation,
          COUNT(*)::int AS n
        FROM usage_event
        WHERE created_at > now() - interval '30 days'
        GROUP BY 1, 2, 3, 4
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_event_daily
           ON usage_event_daily(resource_type, resource_id, day, operation)`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Could not create usage_event_daily matview:", msg);
    }

    // Property.marking_required column — spec §Task 28 column-level
    // stripping uses this to decide which properties to redact.
    await client.query(
      `ALTER TABLE property ADD COLUMN IF NOT EXISTS marking_required TEXT`
    );

    console.log("Created Phase 2 tables (branch, proposal, group, function, favorite, exploration, export, marking, organization, pii_scan_result, usage_event_daily matview)");

    // ------------------------------------------------------------------
    // tasks-01.md — Object Data Funnel (B1-B5)
    //
    // Introduces Postgres as the System of Record for object instances +
    // edits (B1), an Iceberg-style dataset catalog backed by S3 (B2), a
    // durable workflow journal per Object Type (B3), and the changelog /
    // merged Iceberg-style tables produced by the Funnel stages (B4/B5).
    //
    // All tables are append-only where possible so that rollbacks and
    // replays operate on immutable snapshots.
    // ------------------------------------------------------------------

    // B1.a — Extend ontology_edit with the per-stage timestamps that the
    // Funnel uses to find pending work. We keep the legacy `indexed` flag
    // in sync with applied_to_index_at so existing callers continue to
    // work; new callers should prefer the timestamp columns.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'ontology_edit' AND column_name = 'ontology_id') THEN
          ALTER TABLE ontology_edit ADD COLUMN ontology_id UUID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'ontology_edit' AND column_name = 'applied_to_merged_at') THEN
          ALTER TABLE ontology_edit ADD COLUMN applied_to_merged_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'ontology_edit' AND column_name = 'applied_to_index_at') THEN
          ALTER TABLE ontology_edit ADD COLUMN applied_to_index_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'ontology_edit' AND column_name = 'edit_strategy') THEN
          ALTER TABLE ontology_edit ADD COLUMN edit_strategy TEXT NOT NULL DEFAULT 'user_edit_wins'
            CHECK (edit_strategy IN ('user_edit_wins','latest_wins'));
        END IF;
      END
      $$;
    `);
    // Partial indexes on pending-at-each-stage — the Merge and Index
    // stages scan these to find edits that still need to be consumed.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_pending_merge
        ON ontology_edit(object_type_api_name, executed_at ASC)
        WHERE applied_to_merged_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_pending_index
        ON ontology_edit(object_type_api_name, executed_at ASC)
        WHERE applied_to_index_at IS NULL
    `);

    // B1.b — object_instances: polymorphic SoR populated by the Merge
    // stage. PK is (ontology_id, object_type_api_name, primary_key).
    // version bumps on every write so callers can detect staleness.
    // Table name is plural per §B1 of the ontology spec.
    //
    // Pre-spec deployments created this table as singular `object_instance`.
    // Migrate in place so in-flight edits and merged state survive the
    // rename — the code never reads from the singular name again.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_tables
                    WHERE schemaname = 'public' AND tablename = 'object_instance')
           AND NOT EXISTS (SELECT 1 FROM pg_tables
                            WHERE schemaname = 'public' AND tablename = 'object_instances') THEN
          ALTER TABLE object_instance RENAME TO object_instances;
        END IF;
      END $$;
    `);
    const objectInstanceExisted = await tableExists(client, "object_instances");
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_instances (
        ontology_id             UUID        NOT NULL,
        object_type_api_name    TEXT        NOT NULL,
        primary_key             TEXT        NOT NULL,
        properties              JSONB       NOT NULL DEFAULT '{}'::jsonb,
        markings                TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
        source_datasource_id    UUID,
        source_transaction_id   UUID,
        last_modified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        version                 BIGINT      NOT NULL DEFAULT 1,
        PRIMARY KEY (ontology_id, object_type_api_name, primary_key)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_instances_ot
        ON object_instances(object_type_api_name);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_object_instances_modified
        ON object_instances(object_type_api_name, last_modified_at DESC);
    `);
    logTableStatus("object_instances", objectInstanceExisted);

    // B2 — Iceberg-style catalog. We model "tables" and their "snapshots"
    // in Postgres so that stages can be driven by manifest diffs rather
    // than by directory scans. The actual Parquet data lives in S3.
    const funnelDatasetExisted = await tableExists(client, "funnel_dataset");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_dataset (
        dataset_table_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace             TEXT        NOT NULL,
        table_name            TEXT        NOT NULL,
        format_version        INTEGER     NOT NULL DEFAULT 2,
        write_mode            TEXT        NOT NULL DEFAULT 'copy-on-write'
                               CHECK (write_mode IN ('copy-on-write','merge-on-read')),
        schema_json           JSONB       NOT NULL DEFAULT '{}'::jsonb,
        partition_spec_json   JSONB       NOT NULL DEFAULT '[]'::jsonb,
        latest_snapshot_id    UUID,
        min_snapshots_to_keep INTEGER     NOT NULL DEFAULT 100,
        location              TEXT        NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (namespace, table_name)
      );
    `);
    logTableStatus("funnel_dataset", funnelDatasetExisted);

    const funnelSnapshotExisted = await tableExists(client, "funnel_snapshot");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_snapshot (
        snapshot_id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_table_id      UUID        NOT NULL REFERENCES funnel_dataset(dataset_table_id) ON DELETE CASCADE,
        parent_snapshot_id    UUID        REFERENCES funnel_snapshot(snapshot_id),
        operation             TEXT        NOT NULL
                               CHECK (operation IN ('append','overwrite','delete','replace')),
        manifest_json         JSONB       NOT NULL DEFAULT '[]'::jsonb,
        summary_json          JSONB       NOT NULL DEFAULT '{}'::jsonb,
        added_rows            BIGINT      NOT NULL DEFAULT 0,
        added_files           INTEGER     NOT NULL DEFAULT 0,
        committed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_snapshot_table_committed
        ON funnel_snapshot(dataset_table_id, committed_at DESC);
    `);
    logTableStatus("funnel_snapshot", funnelSnapshotExisted);

    // B3 — Durable workflow journal. One `funnel_run` row per workflow
    // instance; stage_run rows record each activity attempt so we can
    // resume at the exact activity boundary after a worker restart.
    const funnelRunExisted = await tableExists(client, "funnel_run");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_run (
        run_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id           UUID        NOT NULL,
        object_type_api_name  TEXT        NOT NULL,
        workflow_type         TEXT        NOT NULL DEFAULT 'ObjectTypeFunnelWorkflow',
        status                TEXT        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running','completed','failed','cancelled')),
        current_stage         TEXT,
        objects_indexed       BIGINT      NOT NULL DEFAULT 0,
        error_message         TEXT,
        signal_payload        JSONB,
        parent_run_id         UUID        REFERENCES funnel_run(run_id) ON DELETE SET NULL,
        started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at          TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_run_ot_started
        ON funnel_run(object_type_api_name, started_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_run_active
        ON funnel_run(object_type_api_name)
        WHERE status = 'running';
    `);
    logTableStatus("funnel_run", funnelRunExisted);

    const funnelStageRunExisted = await tableExists(client, "funnel_stage_run");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_stage_run (
        stage_run_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                UUID        NOT NULL REFERENCES funnel_run(run_id) ON DELETE CASCADE,
        stage                 TEXT        NOT NULL
                               CHECK (stage IN ('changelog','merge','indexing','hydration')),
        status                TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','running','succeeded','failed','timed_out')),
        attempt               INTEGER     NOT NULL DEFAULT 1,
        input_json            JSONB,
        output_json           JSONB,
        error_message         TEXT,
        timeout_seconds       INTEGER     NOT NULL DEFAULT 3600,
        started_at            TIMESTAMPTZ,
        finished_at           TIMESTAMPTZ,
        UNIQUE (run_id, stage, attempt)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_stage_run_status
        ON funnel_stage_run(status, started_at);
    `);
    logTableStatus("funnel_stage_run", funnelStageRunExisted);

    // Signal inbox for ObjectTypeFunnelWorkflow. A signal is a durable
    // request to the workflow to wake up and evaluate new work.
    const funnelSignalExisted = await tableExists(client, "funnel_signal");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_signal (
        signal_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        ontology_id           UUID        NOT NULL,
        object_type_api_name  TEXT        NOT NULL,
        signal_type           TEXT        NOT NULL
                               CHECK (signal_type IN ('sourceTransactionCommitted',
                                                      'editBatchPending',
                                                      'schemaChanged')),
        payload               JSONB       NOT NULL DEFAULT '{}'::jsonb,
        received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        consumed_at           TIMESTAMPTZ,
        consumed_by_run_id    UUID        REFERENCES funnel_run(run_id) ON DELETE SET NULL
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_funnel_signal_pending
        ON funnel_signal(object_type_api_name, received_at ASC)
        WHERE consumed_at IS NULL;
    `);
    logTableStatus("funnel_signal", funnelSignalExisted);

    // B4 — Changelog snapshot head watermark per (object_type, datasource).
    // We keep this denormalized from funnel_snapshot so the changelog
    // activity can quickly look up "what was the last snapshot I emitted
    // for this source?" without scanning manifests.
    const changelogWatermarkExisted = await tableExists(client, "funnel_changelog_watermark");
    await client.query(`
      CREATE TABLE IF NOT EXISTS funnel_changelog_watermark (
        ontology_id           UUID        NOT NULL,
        object_type_api_name  TEXT        NOT NULL,
        source_datasource_id  UUID        NOT NULL,
        last_from_snapshot_id UUID,
        last_to_snapshot_id   UUID,
        last_run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_rows_emitted     BIGINT      NOT NULL DEFAULT 0,
        PRIMARY KEY (ontology_id, object_type_api_name, source_datasource_id)
      );
    `);
    logTableStatus("funnel_changelog_watermark", changelogWatermarkExisted);

    console.log("Created Funnel pipeline tables (object_instances, funnel_dataset, funnel_snapshot, funnel_run, funnel_stage_run, funnel_signal, funnel_changelog_watermark)");

    // ------------------------------------------------------------------
    // B9 — Replacement pipeline (dual-index + soak). Mirrors
    // src/migrations/013_replacement_pipeline.sql so a fresh `npm run
    // migrate` brings the tables up without an extra step.
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'replacement_state') THEN
          CREATE TYPE replacement_state AS ENUM (
            'LIVE',
            'REPLACEMENT_BACKFILL',
            'REPLACEMENT_SOAK',
            'CUTOVER_PENDING',
            'CUTOVER_COMPLETE',
            'OLD_INDEX_DROPPED',
            'ROLLED_BACK'
          );
        END IF;
      END $$;
    `);
    const otActiveExisted = await tableExists(client, "object_type_active_index_version");
    await client.query(`
      CREATE TABLE IF NOT EXISTS object_type_active_index_version (
        object_type_api_name     TEXT              PRIMARY KEY,
        active_version           INTEGER           NOT NULL DEFAULT 1,
        pending_version          INTEGER,
        state                    replacement_state NOT NULL DEFAULT 'LIVE',
        soak_days                INTEGER           NOT NULL DEFAULT 7
                                  CHECK (soak_days BETWEEN 1 AND 14),
        diff_rate_threshold      DOUBLE PRECISION  NOT NULL DEFAULT 0.001,
        backfill_started_at      TIMESTAMPTZ,
        soak_started_at          TIMESTAMPTZ,
        last_cutover_at          TIMESTAMPTZ,
        last_rollback_at         TIMESTAMPTZ,
        old_index_retained_until TIMESTAMPTZ,
        updated_at               TIMESTAMPTZ       NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_otaiv_state
        ON object_type_active_index_version (state);
    `);
    logTableStatus("object_type_active_index_version", otActiveExisted);

    const replDiffExisted = await tableExists(client, "replacement_diff_log");
    await client.query(`
      CREATE TABLE IF NOT EXISTS replacement_diff_log (
        id                   BIGSERIAL    PRIMARY KEY,
        object_type_api_name TEXT         NOT NULL,
        old_version          INTEGER      NOT NULL,
        new_version          INTEGER      NOT NULL,
        query_hash           TEXT         NOT NULL,
        query_body           JSONB,
        diff_count           INTEGER      NOT NULL DEFAULT 0,
        total_hits           INTEGER      NOT NULL DEFAULT 0,
        recorded_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rdl_type_recorded
        ON replacement_diff_log (object_type_api_name, recorded_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rdl_type_versions
        ON replacement_diff_log (object_type_api_name, old_version, new_version);
    `);
    logTableStatus("replacement_diff_log", replDiffExisted);

    console.log("Created B9 replacement pipeline tables (object_type_active_index_version, replacement_diff_log)");

    // ------------------------------------------------------------------
    // B4 — add iceberg_location to backing_datasource so the DuckDB
    // iceberg_scan reader knows where to find the source's metadata
    // (distinct from the legacy raw file_path).
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'backing_datasource' AND column_name = 'iceberg_location') THEN
          ALTER TABLE backing_datasource ADD COLUMN iceberg_location TEXT;
        END IF;
      END $$;
    `);
    console.log("Ensured backing_datasource has iceberg_location column (B4)");

    // ------------------------------------------------------------------
    // B3 — dedupe funnel_run rows across Temporal stage transitions.
    // The Temporal path projects `current_stage` on every stage change;
    // without a stable key it would create a new run row per stage. We
    // add a temporal_workflow_id column and a unique index so
    // projectStageToPostgres can UPSERT against it.
    // ------------------------------------------------------------------
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'funnel_run' AND column_name = 'temporal_workflow_id') THEN
          ALTER TABLE funnel_run ADD COLUMN temporal_workflow_id TEXT;
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_funnel_run_temporal_wf
        ON funnel_run(temporal_workflow_id)
        WHERE temporal_workflow_id IS NOT NULL;
    `);
    console.log("Ensured funnel_run has temporal_workflow_id UPSERT key (B3)");

    // ------------------------------------------------------------------
    // LT-B1..B10 — Link Type Extensions (017_link_type_extensions.sql).
    // Inlined so a fresh `npm run migrate` picks the new columns and
    // tables up without requiring the side migration runner.
    // ------------------------------------------------------------------
    const fsMod = await import("fs");
    const pathMod = await import("path");
    try {
      const sqlFile = pathMod.join(__dirname, "migrations", "017_link_type_extensions.sql");
      if (fsMod.existsSync(sqlFile)) {
        const sql = fsMod.readFileSync(sqlFile, "utf-8");
        await client.query(sql);
        console.log("Applied 017_link_type_extensions.sql (LT-B1..B10)");
      } else {
        // Fall back to dist layout (./migrations next to migrate.js after tsc).
        const distFile = pathMod.join(__dirname, "..", "src", "migrations", "017_link_type_extensions.sql");
        if (fsMod.existsSync(distFile)) {
          await client.query(fsMod.readFileSync(distFile, "utf-8"));
          console.log("Applied 017_link_type_extensions.sql (LT-B1..B10, dist path)");
        } else {
          console.warn("[migrate] 017_link_type_extensions.sql not found — skipping LT extensions");
        }
      }
    } catch (sqlErr) {
      const msg = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
      throw new Error(`017_link_type_extensions.sql failed: ${msg}`);
    }

    // ------------------------------------------------------------------
    // FNL-H2 / FNL-H3 / FNL-H4 (018_funnel_hardening.sql). Same inlining
    // pattern as 017 so a fresh `npm run migrate` is self-sufficient.
    // ------------------------------------------------------------------
    try {
      const sqlFile = pathMod.join(__dirname, "migrations", "018_funnel_hardening.sql");
      if (fsMod.existsSync(sqlFile)) {
        await client.query(fsMod.readFileSync(sqlFile, "utf-8"));
        console.log("Applied 018_funnel_hardening.sql (FNL-H2/H3/H4)");
      }
    } catch (sqlErr) {
      const msg = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
      throw new Error(`018_funnel_hardening.sql failed: ${msg}`);
    }

    // ------------------------------------------------------------------
    // PB-B3..B10 + FNL-H follow-ups (migrations 019–032). Each file is
    // idempotent (ALTER ... IF NOT EXISTS, CREATE OR REPLACE) so
    // re-running migrate on an already-bootstrapped environment is
    // safe. Migration 032 installs the schema_migrations_applied
    // ledger, so from 032 onwards we both apply and record in the
    // ledger. Unapplied migrations show up as a diff between the
    // filename list below and the ledger query.
    // ------------------------------------------------------------------
    const sequencedMigrations = [
      "019_pipeline_output_format.sql",
      "020_pipeline_iceberg.sql",
      "021_pipeline_streaming.sql",
      "022_pipeline_preview_pinning.sql",
      "023_pipeline_rbac.sql",
      "024_dataset_lineage.sql",
      "025_pipeline_cbac.sql",
      "026_fnl_h3_pipeline_deploy_signal.sql",
      "027_bd_foundry_dataset_id.sql",
      "028_schema_evolution.sql",
      "029_funnel_input_lineage_trigger.sql",
      "030_keycloak_group_map.sql",
      "031_pipeline_snapshot_invariants.sql",
      "032_migration_ledger.sql",
    ];

    // First pass: make sure the ledger exists before we try to use it
    // as a skip-list. 032 is special: once it lands, subsequent runs
    // consult the ledger.
    try {
      const sqlFile = pathMod.join(__dirname, "migrations", "032_migration_ledger.sql");
      if (fsMod.existsSync(sqlFile)) {
        await client.query(fsMod.readFileSync(sqlFile, "utf-8"));
      }
    } catch (sqlErr) {
      // Not fatal — the ledger will catch up on the next run.
      console.warn(
        `[migrate] could not bootstrap ledger: ${sqlErr instanceof Error ? sqlErr.message : String(sqlErr)}`,
      );
    }

    // Second pass: walk every sequenced migration. Skip if the ledger
    // says it's already applied; otherwise apply + record.
    const crypto = await import("crypto");
    const applied = await client
      .query(`SELECT migration_name FROM schema_migrations_applied`)
      .then((r) => new Set(r.rows.map((row: { migration_name: string }) => row.migration_name)))
      .catch(() => new Set<string>());

    for (const name of sequencedMigrations) {
      if (applied.has(name)) {
        console.log(`Skipping ${name} (already applied per ledger)`);
        continue;
      }
      try {
        const sqlFile = pathMod.join(__dirname, "migrations", name);
        if (!fsMod.existsSync(sqlFile)) continue;
        const sql = fsMod.readFileSync(sqlFile, "utf-8");
        await client.query(sql);
        const checksum = crypto.createHash("sha256").update(sql).digest("hex");
        await client.query(
          `INSERT INTO schema_migrations_applied (migration_name, checksum)
           VALUES ($1, $2)
           ON CONFLICT (migration_name) DO UPDATE
             SET checksum = EXCLUDED.checksum`,
          [name, checksum],
        );
        console.log(`Applied ${name}`);
      } catch (sqlErr) {
        const msg = sqlErr instanceof Error ? sqlErr.message : String(sqlErr);
        throw new Error(`${name} failed: ${msg}`);
      }
    }

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
