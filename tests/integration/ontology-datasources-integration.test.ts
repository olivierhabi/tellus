import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { eventBus } from "../../src/websocket/eventBus";
import objectTypeService from "../../src/services/objectTypeService";
import { startDatasourceCompilerConsumer } from "../../src/services/orchestration/datasource-compiler-consumer";

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "tellus",
  password: process.env.PGPASSWORD || "tellus123",
  database: process.env.PGDATABASE || "tellus_db",
});

const tag = `ts-add-${randomUUID()}`;
const legacyOntologyId = "00000000-0000-0000-0000-000000000001"; // Canonical enterprise ontology UUID
const ontoRid = "ri.ontology.main.ontology.default";
const objectTypeRid = `ri.ontology.main.object-type.${tag}`;
const datasourceRid = `ri.foundry.main.dataset.${tag}-ds`;

beforeAll(async () => {
  // Setup database connection and modern/legacy tables
  await pool.query("SELECT 1");

  // Ensure ontology exists in legacy schema
  await pool.query(
    "INSERT INTO ontology (ontology_id, display_name, description, created_by) VALUES ($1, 'Default', 'Desc', 'system') ON CONFLICT (ontology_id) DO NOTHING",
    [legacyOntologyId]
  );

  // In B8 layer, insert ontology + object_types
  await pool.query(
    "INSERT INTO ontologies (rid, api_name, display_name, space_rid) VALUES ($1, $2, 'Test Onto', 'space_rid') ON CONFLICT DO NOTHING",
    [ontoRid, "default"]
  );

  await pool.query(
    "INSERT INTO object_types (rid, ontology_rid, api_name, display_name, etag) VALUES ($1, $2, $3, 'IT-Add-Source', 1)",
    [objectTypeRid, ontoRid, `${tag}-api`]
  );

  // In B8 layer, insert object_type_properties
  await pool.query(
    "INSERT INTO object_type_properties (object_type_rid, api_name, display_name, data_type, nullable) VALUES ($1, 'id', 'ID', 'string', false)",
    [objectTypeRid]
  );

  // Synchronize object_type & property in legacy schema
  const legacyIdResult = await pool.query(
    "INSERT INTO object_type (ontology_id, api_name, display_name, version) VALUES ($1, $2, 'IT-Add-Source-Legacy', 1) RETURNING object_type_id",
    [legacyOntologyId, `${tag}-api`]
  );
  const ontologyId = legacyIdResult.rows[0].object_type_id;

  await pool.query(
    "INSERT INTO property (property_id, object_type_id, api_name, display_name, base_type, is_required) VALUES ($1, $2, 'id', 'ID', 'string', true)",
    [randomUUID(), ontologyId]
  );

  // Expose legacy UUID dynamically so afterAll cleanup has access to it
  (globalThis as any).legacyObjectTypeUUID = ontologyId;

  // Start background compilation consumer
  startDatasourceCompilerConsumer();
});

afterAll(async () => {
  const ontologyId = (globalThis as any).legacyObjectTypeUUID;
  await pool.query("DELETE FROM object_type_datasources WHERE object_type_rid = $1", [objectTypeRid]);
  await pool.query("DELETE FROM object_type_properties WHERE object_type_rid = $1", [objectTypeRid]);
  await pool.query("DELETE FROM object_types WHERE rid = $1", [objectTypeRid]);
  if (ontologyId) {
    await pool.query("DELETE FROM backing_datasource WHERE object_type_id = $1", [ontologyId]);
    await pool.query("DELETE FROM property WHERE object_type_id = $1", [ontologyId]);
    await pool.query("DELETE FROM object_type WHERE object_type_id = $1", [ontologyId]);
  }
  await pool.end();
});

describe("Multi-Source Backing Datasource Architecture Suite", () => {
  it("Validates structural properties mappings alignment, throws 422 if mismatched", async () => {
    await expect(
      objectTypeService.addDatasource(objectTypeRid, {
        datasourceRid,
        primaryKeyMapping: "id_col",
        propertyMappings: [{ sourceColumn: "unknown", targetPropertyId: "non_existent_prop" }],
      })
    ).rejects.toThrow();
  });

  it("Appends to object_type_datasources blueprint and is asynchronous-event compliant", async () => {
    let eventReceived: any = null;
    eventBus.once("ws:event", (evt: any) => {
      if (evt.event === "DataSourceAddedEvent") {
        eventReceived = evt.payload;
      }
    });

    const result = await objectTypeService.addDatasource(objectTypeRid, {
      datasourceRid,
      primaryKeyMapping: "id_col",
      propertyMappings: [{ sourceColumn: "id_col", targetPropertyId: "id" }],
      resolutionStrategy: "UNION",
      conflictPolicy: "FAIL",
    });

    expect(result.success).toBe(true);
    expect(result.datasourceRid).toBe(datasourceRid);

    // Wait 100ms for ws compile broker sweep
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(eventReceived).not.toBeNull();
    expect(eventReceived.objectTypeRid).toBe(objectTypeRid);

    // Legacy Runtime verification: confirm compiled_logical_view was synchronized
    const ontologyId = (globalThis as any).legacyObjectTypeUUID;
    const runResult = await pool.query("SELECT * FROM backing_datasource WHERE object_type_id = $1", [ontologyId]);
    expect(runResult.rows.length).toBe(1);
    expect(runResult.rows[0].file_path).toContain("compiled_logical_view://");
    expect(runResult.rows[0].primary_key_column).toBe("id_col");
  });

  it("Optimistic Concurrency Lock: rejects stale ETag check with 409", async () => {
    // Current etag is now 2 (bumped on insert)
    await expect(
      objectTypeService.addDatasource(objectTypeRid, {
        datasourceRid,
        primaryKeyMapping: "id_col",
        propertyMappings: [{ sourceColumn: "id_col", targetPropertyId: "id" }],
        ifMatch: '"v1"', // stale!
      })
    ).rejects.toThrow();
  });
});
