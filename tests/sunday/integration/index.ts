// ---------------------------------------------------------------------------
// Sunday Integration Test Orchestrator
//
// Standalone runner for Sunday integration tests.
// Run: npx tsx tests/sunday/integration/index.ts
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api, BASE_URL } from "../../helpers/api";
import { ensureServer, stopServer } from "../../helpers/server";
import { createContext } from "./context";

async function main() {
  console.log(`\nSunday Integration Tests against ${BASE_URL}\n`);

  const runner = new Runner();
  const ctx = createContext();

  await ensureServer();

  // --- Setup ---
  runner.section("Setup");

  await runner.test("Create ontology", async () => {
    const { status, body } = await api("POST", "/api/v2/ontologies", {
      displayName: "Sunday Standalone Test",
    });
    runner.assert(status === 201, `Expected 201, got ${status}`);
    ctx.ontologyId = body.data?.ontologyId || body.ontologyId;
  });

  await runner.test("Create Airport OT", async () => {
    const { status } = await api("POST", `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/batch`, {
      apiName: "StandaloneAirport",
      displayName: "Airport",
      properties: [
        { apiName: "airportId", displayName: "ID", baseType: "string", isRequired: true },
        { apiName: "lat", displayName: "Lat", baseType: "double" },
        { apiName: "lng", displayName: "Lng", baseType: "double" },
      ],
      primaryKeyProperty: "airportId",
    });
    runner.assert(status === 201, `Expected 201, got ${status}`);
    ctx.objectType1ApiName = "StandaloneAirport";
  });

  // --- Interface CRUD ---
  runner.section("Interface CRUD");

  await runner.test("Create Interface", async () => {
    const { status, body } = await api("POST", `/api/v2/ontology/${ctx.ontologyId}/interfaces`, {
      apiName: "StandaloneLocation",
      displayName: "Location",
      properties: [
        { apiName: "latitude", displayName: "Lat", baseType: "double", isRequired: true },
        { apiName: "longitude", displayName: "Lng", baseType: "double", isRequired: true },
      ],
    });
    runner.assert(status === 201, `Expected 201, got ${status}`);
    ctx.interfaceApiName = "StandaloneLocation";
  });

  await runner.test("List interfaces", async () => {
    const { status, body } = await api("GET", `/api/v2/ontology/${ctx.ontologyId}/interfaces`);
    runner.assert(status === 200, `Expected 200, got ${status}`);
    runner.assert((body?.data?.length || 0) >= 1, "At least 1 interface");
  });

  await runner.test("Get interface by name", async () => {
    const { status } = await api("GET", `/api/v2/ontology/${ctx.ontologyId}/interfaces/StandaloneLocation`);
    runner.assert(status === 200, `Expected 200, got ${status}`);
  });

  // --- Implementation ---
  runner.section("Interface Implementation");

  await runner.test("Implement interface", async () => {
    const { status } = await api("POST",
      `/api/v2/ontology/${ctx.ontologyId}/objectTypes/StandaloneAirport/implements`, {
        interfaceApiName: "StandaloneLocation",
        propertyMapping: { latitude: "lat", longitude: "lng" },
      });
    runner.assert(status === 201, `Expected 201, got ${status}`);
  });

  await runner.test("List implementations", async () => {
    const { status, body } = await api("GET",
      `/api/v2/ontology/${ctx.ontologyId}/objectTypes/StandaloneAirport/implements`);
    runner.assert(status === 200, `Expected 200, got ${status}`);
    runner.assert((body?.data?.length || 0) >= 1, "At least 1 implementation");
  });

  // --- Health ---
  runner.section("System Health");

  await runner.test("Liveness probe", async () => {
    const { status } = await api("GET", "/api/v2/system/liveness");
    runner.assert(status === 200, `Expected 200, got ${status}`);
  });

  // --- Cleanup ---
  runner.section("Cleanup");

  await runner.test("Remove implementation", async () => {
    const { status } = await api("DELETE",
      `/api/v2/ontology/${ctx.ontologyId}/objectTypes/StandaloneAirport/implements/StandaloneLocation`);
    runner.assert(status === 204, `Expected 204, got ${status}`);
  });

  await runner.test("Delete interface", async () => {
    const { status } = await api("DELETE", `/api/v2/ontology/${ctx.ontologyId}/interfaces/StandaloneLocation`);
    runner.assert(status === 204, `Expected 204, got ${status}`);
  });

  await runner.test("Delete ontology", async () => {
    const { status } = await api("DELETE", `/api/v2/ontologies/${ctx.ontologyId}`);
    runner.assert(status === 204, `Expected 204, got ${status}`);
  });

  runner.summary("Sunday Integration");
  stopServer();
  process.exit(runner.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
