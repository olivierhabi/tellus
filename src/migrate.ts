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
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

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
