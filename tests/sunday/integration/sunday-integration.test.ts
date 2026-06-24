// ---------------------------------------------------------------------------
// Sunday Integration Tests — Tasks 1-9, 11-14
//
// End-to-end API tests against a running Express server. Tests the Interface
// system (CRUD, implementation, polymorphic queries) and Object View API.
//
// Requires PostgreSQL. Skips gracefully if unavailable.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Runner } from "../../helpers/runner";
import { ensureServer, stopServer } from "../../helpers/server";
import { api, BASE_URL } from "../../helpers/api";
import { createContext, SundayTestContext } from "./context";

// ---------------------------------------------------------------------------
// Service availability check
// ---------------------------------------------------------------------------

async function isPostgresAvailable(): Promise<boolean> {
  try {
    const { Pool } = require("pg");
    const pool = new Pool({
      host: process.env.PGHOST || "localhost",
      port: parseInt(process.env.PGPORT || "5432", 10),
      database: process.env.PGDATABASE || "tellus_db",
      user: process.env.PGUSER || "tellus",
      password: process.env.PGPASSWORD || "tellus123",
      connectionTimeoutMillis: 3000,
    });
    await pool.query("SELECT 1");
    await pool.end();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Sunday Integration Tests", async () => {
  const pgOk = await isPostgresAvailable();

  if (!pgOk) {
    it.skip("PostgreSQL is not available — skipping integration tests", () => {});
    return;
  }

  const runner = new Runner();
  const ctx = createContext();

  beforeAll(async () => {
    await ensureServer();
  }, 30_000);

  afterAll(async () => {
    // Cleanup
    try {
      if (ctx.ontologyId) {
        // Remove implementations first
        if (ctx.objectType1ApiName && ctx.interfaceApiName) {
          await api("DELETE",
            `/api/v1/ontology/${ctx.ontologyId}/objectTypes/${ctx.objectType1ApiName}/implements/${ctx.interfaceApiName}`
          );
        }
        if (ctx.objectType2ApiName && ctx.interfaceApiName) {
          await api("DELETE",
            `/api/v1/ontology/${ctx.ontologyId}/objectTypes/${ctx.objectType2ApiName}/implements/${ctx.interfaceApiName}`
          );
        }
        // Delete interface
        if (ctx.interfaceApiName) {
          await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/interfaces/${ctx.interfaceApiName}`);
        }
        // Singleton: ontology delete is frozen (409), so delete the object
        // types this suite created explicitly (cascade no longer fires).
        for (const ot of [ctx.objectType1ApiName, ctx.objectType2ApiName]) {
          if (ot) await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/objectTypes/${ot}`);
        }
      }
    } catch { /* ignore */ }
    stopServer();
  });

  // --- Suite 1: Setup ---
  it("Setup: Create ontology and object types", async () => {
    const bf = runner.failed;

    await runner.test("Create ontology", async () => {
      // Singleton deployment: POST /api/v1/ontology is frozen (ONTOLOGY_SINGLETON).
      // Resolve the single canonical enterprise ontology instead of creating one.
      const listRes = await api("GET", "/api/v1/ontology");
      ctx.ontologyId = listRes.body?.data?.[0]?.ontologyId || "";
      runner.assert(!!ctx.ontologyId, "ontologyId present (canonical)");

      // Pre-clean leftovers from a prior interrupted run (the ontology delete
      // cascade no longer fires under the singleton model).
      for (const ot of ["SunAirport", "SunWarehouse"]) {
        try { await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/objectTypes/${ot}`); } catch { /* ignore */ }
      }
      try { await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`); } catch { /* ignore */ }
    });

    await runner.test("Create Airport object type", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/objectTypes/batch`, {
        apiName: "SunAirport",
        displayName: "Sunday Airport",
        properties: [
          { apiName: "airportId", displayName: "Airport ID", baseType: "string", isRequired: true },
          { apiName: "airportName", displayName: "Airport Name", baseType: "string" },
          { apiName: "airportLatitude", displayName: "Latitude", baseType: "double" },
          { apiName: "airportLongitude", displayName: "Longitude", baseType: "double" },
          { apiName: "airportCity", displayName: "City", baseType: "string" },
        ],
        primaryKeyProperty: "airportId",
        titleProperty: "airportName",
      });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
      ctx.objectType1ApiName = "SunAirport";
    });

    await runner.test("Create Warehouse object type", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/objectTypes/batch`, {
        apiName: "SunWarehouse",
        displayName: "Sunday Warehouse",
        properties: [
          { apiName: "warehouseId", displayName: "Warehouse ID", baseType: "string", isRequired: true },
          { apiName: "warehouseName", displayName: "Name", baseType: "string" },
          { apiName: "warehouseLat", displayName: "Latitude", baseType: "double" },
          { apiName: "warehouseLng", displayName: "Longitude", baseType: "double" },
        ],
        primaryKeyProperty: "warehouseId",
        titleProperty: "warehouseName",
      });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
      ctx.objectType2ApiName = "SunWarehouse";
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Suite 2: Interface CRUD ---
  it("Interface CRUD: Create, list, get, update, delete", async () => {
    const bf = runner.failed;

    await runner.test("Create Interface HasLocation", async () => {
      const { status, body } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/interfaces`, {
        apiName: "SunHasLocation",
        displayName: "Has Geographic Location",
        description: "Interface for objects with geographic coordinates",
        properties: [
          { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: true },
          { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: true },
          { apiName: "locationName", displayName: "Location Name", baseType: "string", isRequired: false },
        ],
      });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
      ctx.interfaceApiName = "SunHasLocation";
      if (status === 201) {
        ctx.interfaceId = body?.data?.interfaceId || "";
      }
    });

    await runner.test("Reject duplicate Interface apiName", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/interfaces`, {
        apiName: "SunHasLocation",
        displayName: "Duplicate",
        properties: [{ apiName: "prop1", displayName: "P1", baseType: "string" }],
      });
      runner.assert(status === 409, `Expected 409, got ${status}`);
    });

    await runner.test("Reject invalid apiName (lowercase)", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/interfaces`, {
        apiName: "hasLocation",
        displayName: "Bad Name",
        properties: [{ apiName: "prop1", displayName: "P1", baseType: "string" }],
      });
      runner.assert(status === 400, `Expected 400, got ${status}`);
    });

    await runner.test("Reject empty properties", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/interfaces`, {
        apiName: "EmptyProps",
        displayName: "Empty",
        properties: [],
      });
      runner.assert(status === 400, `Expected 400, got ${status}`);
    });

    await runner.test("List interfaces", async () => {
      const { status, body } = await api("GET", `/api/v1/ontology/${ctx.ontologyId}/interfaces`);
      runner.assert(status === 200, `Expected 200, got ${status}`);
      const data = body?.data || [];
      runner.assert(data.length >= 1, `Expected >= 1 interface, got ${data.length}`);
    });

    await runner.test("Get single interface", async () => {
      const { status, body } = await api("GET", `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`);
      runner.assert(status === 200, `Expected 200, got ${status}`);
      const apiName = body?.data?.apiName;
      runner.assert(apiName === "SunHasLocation", `apiName mismatch: ${apiName}`);
    });

    await runner.test("404 for non-existent interface", async () => {
      const { status } = await api("GET", `/api/v1/ontology/${ctx.ontologyId}/interfaces/NonExistent`);
      runner.assert(status === 404, `Expected 404, got ${status}`);
    });

    await runner.test("Update interface display name via PUT", async () => {
      const { status, body } = await api("PUT", `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`, {
        displayName: "Has Geographic Location (Updated)",
        description: "Updated description",
        properties: [
          { apiName: "latitude", displayName: "Latitude", baseType: "double", isRequired: true },
          { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: true },
          { apiName: "locationName", displayName: "Location Name", baseType: "string", isRequired: false },
        ],
      });
      runner.assert(status === 200, `Expected 200, got ${status}`);
    });

    // Create a second interface to test deletion
    await runner.test("Create temporary interface for delete test", async () => {
      const { status } = await api("POST", `/api/v1/ontology/${ctx.ontologyId}/interfaces`, {
        apiName: "SunTempInterface",
        displayName: "Temporary",
        properties: [{ apiName: "prop1", displayName: "P1", baseType: "string" }],
      });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
    });

    await runner.test("Delete interface with no implementations", async () => {
      const { status } = await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunTempInterface`);
      runner.assert(status === 204, `Expected 204, got ${status}`);
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Suite 3: Interface Implementation ---
  it("Interface Implementation: implement, validate, list, remove", async () => {
    const bf = runner.failed;

    await runner.test("Airport implements SunHasLocation", async () => {
      const { status, body } = await api("POST",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunAirport/implements`, {
          interfaceApiName: "SunHasLocation",
          propertyMapping: {
            latitude: "airportLatitude",
            longitude: "airportLongitude",
            locationName: "airportCity",
          },
        });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
    });

    await runner.test("Reject duplicate implementation", async () => {
      const { status } = await api("POST",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunAirport/implements`, {
          interfaceApiName: "SunHasLocation",
          propertyMapping: {
            latitude: "airportLatitude",
            longitude: "airportLongitude",
          },
        });
      runner.assert(status === 409, `Expected 409, got ${status}`);
    });

    await runner.test("Reject missing required mapping", async () => {
      const { status } = await api("POST",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunWarehouse/implements`, {
          interfaceApiName: "SunHasLocation",
          propertyMapping: {
            latitude: "warehouseLat",
            // Missing longitude which is required
          },
        });
      runner.assert(status === 400, `Expected 400, got ${status}`);
    });

    await runner.test("Warehouse implements SunHasLocation (correct mapping)", async () => {
      const { status } = await api("POST",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunWarehouse/implements`, {
          interfaceApiName: "SunHasLocation",
          propertyMapping: {
            latitude: "warehouseLat",
            longitude: "warehouseLng",
          },
        });
      runner.assert(status === 201 || status === 409, `Expected 201 or 409, got ${status}`);
    });

    await runner.test("List implementations for Airport", async () => {
      const { status, body } = await api("GET",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunAirport/implements`);
      runner.assert(status === 200, `Expected 200, got ${status}`);
      const data = body?.data || [];
      runner.assert(data.length >= 1, `Expected >= 1, got ${data.length}`);
    });

    await runner.test("Prevent deleting interface with implementations", async () => {
      const { status } = await api("DELETE",
        `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`);
      runner.assert(status === 409, `Expected 409, got ${status}`);
    });

    await runner.test("Prevent removing mapped property via PUT", async () => {
      const { status } = await api("PUT",
        `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`, {
          displayName: "Has Geographic Location",
          properties: [
            // Removing latitude which is mapped
            { apiName: "longitude", displayName: "Longitude", baseType: "double", isRequired: true },
          ],
        });
      runner.assert(status === 409, `Expected 409, got ${status}`);
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Suite 4: Interface shows implementing types ---
  it("Interface GET shows implementing object types", async () => {
    const bf = runner.failed;

    await runner.test("GET interface shows implementors", async () => {
      const { status, body } = await api("GET",
        `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`);
      runner.assert(status === 200, `Expected 200, got ${status}`);
      const implementors = body?.data?.implementingObjectTypes || [];
      runner.assert(implementors.length >= 2, `Expected >= 2 implementors, got ${implementors.length}`);
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Suite 5: System Health ---
  it("System Health: health, readiness, liveness", async () => {
    const bf = runner.failed;

    await runner.test("System health endpoint", async () => {
      const { status } = await api("GET", "/api/v1/system/health");
      runner.assert(status === 200 || status === 503, `Expected 200/503, got ${status}`);
    });

    await runner.test("Readiness probe", async () => {
      const { status } = await api("GET", "/api/v1/system/readiness");
      runner.assert(status === 200 || status === 503, `Expected 200/503, got ${status}`);
    });

    await runner.test("Liveness probe", async () => {
      const { status } = await api("GET", "/api/v1/system/liveness");
      runner.assert(status === 200, `Expected 200, got ${status}`);
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Suite 6: Cleanup ---
  it("Cleanup: Remove all test data", async () => {
    const bf = runner.failed;

    await runner.test("Remove Airport implementation", async () => {
      const { status } = await api("DELETE",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunAirport/implements/SunHasLocation`);
      runner.assert(status === 204 || status === 404, `Expected 204 or 404, got ${status}`);
    });

    await runner.test("Remove Warehouse implementation", async () => {
      const { status } = await api("DELETE",
        `/api/v1/ontology/${ctx.ontologyId}/objectTypes/SunWarehouse/implements/SunHasLocation`);
      runner.assert(status === 204 || status === 404, `Expected 204 or 404, got ${status}`);
    });

    await runner.test("Delete interface", async () => {
      const { status } = await api("DELETE",
        `/api/v1/ontology/${ctx.ontologyId}/interfaces/SunHasLocation`);
      runner.assert(status === 204 || status === 404, `Expected 204 or 404, got ${status}`);
    });

    await runner.test("Delete ontology (cascade)", async () => {
      const { status } = await api("DELETE", `/api/v1/ontology/${ctx.ontologyId}`);
      // Singleton deployment: deleting the canonical ontology is frozen → 409.
      runner.assert(status === 204 || status === 409, `Expected 204 or 409 (frozen), got ${status}`);
      ctx.ontologyId = ctx.ontologyId; // keep id so afterAll cleans up the OTs we created
    });

    expect(runner.failed).toBe(bf);
  });

  // --- Final ---
  it("all Sunday integration tests pass", () => {
    expect(runner.failed).toBe(0);
    expect(runner.passed).toBeGreaterThan(0);
    console.log(`\n  Sunday Integration: ${runner.passed} passed, ${runner.failed} failed\n`);
  });
});
