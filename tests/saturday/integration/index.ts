// ---------------------------------------------------------------------------
// Saturday Integration Test Orchestrator
//
// Standalone runner for Saturday integration tests.
// Run: npx tsx tests/saturday/integration/index.ts
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api, BASE_URL } from "../../helpers/api";
import { ensureServer, stopServer } from "../../helpers/server";
import { createContext } from "./context";
import fs from "fs";
import path from "path";

async function main() {
  console.log(`\nSaturday Integration Tests against ${BASE_URL}\n`);

  const runner = new Runner();
  const ctx = createContext();

  await ensureServer();

  // Setup test data
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  ctx.employeeCsvPath = path.join(dataDir, "sat-standalone-employees.csv");
  fs.writeFileSync(ctx.employeeCsvPath, [
    "emp_id,full_name,salary,department,is_active",
    "E001,Alice Uwimana,75000.50,Engineering,true",
    "E002,Bob Habimana,82000.00,Engineering,true",
    "E003,Carol Mugisha,91000.75,Sales,false",
  ].join("\n"));

  // --- Run tests ---
  runner.section("Ontology Setup");

  await runner.test("Create ontology", async () => {
    const { status, body } = await api("POST", "/api/v2/ontologies", {
      displayName: "Saturday Standalone Test",
    });
    runner.assert(status === 201, `Expected 201, got ${status}`);
    ctx.ontologyId = body.data?.ontologyId || body.ontologyId;
  });

  await runner.test("Create Employee object type", async () => {
    const { status } = await api("POST", `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/batch`, {
      apiName: "StandaloneEmployee",
      displayName: "Standalone Employee",
      properties: [
        { apiName: "employeeId", displayName: "ID", baseType: "string", isRequired: true },
        { apiName: "fullName", displayName: "Name", baseType: "string" },
        { apiName: "salary", displayName: "Salary", baseType: "double" },
        { apiName: "department", displayName: "Dept", baseType: "string" },
        { apiName: "isActive", displayName: "Active", baseType: "boolean" },
      ],
      primaryKeyProperty: "employeeId",
      titleProperty: "fullName",
    });
    runner.assert(status === 201, `Expected 201, got ${status}`);
  });

  runner.section("Dataset Operations");

  await runner.test("List datasets", async () => {
    const { status } = await api("GET", "/api/v2/datasets");
    runner.assert(status === 200, `Expected 200, got ${status}`);
  });

  await runner.test("Register datasource", async () => {
    const { status } = await api("POST",
      `/api/v2/ontologies/${ctx.ontologyId}/objectTypes/StandaloneEmployee/datasource`, {
        datasetName: "Standalone Dataset",
        filePath: ctx.employeeCsvPath,
        fileFormat: "csv",
        columnMapping: {
          employeeId: "emp_id",
          fullName: "full_name",
          salary: "salary",
          department: "department",
          isActive: "is_active",
        },
      });
    runner.assert(status === 201, `Expected 201, got ${status}`);
  });

  runner.section("Health Endpoints");

  await runner.test("Health check", async () => {
    const { status } = await api("GET", "/health");
    runner.assert(status === 200, `Expected 200, got ${status}`);
  });

  // Cleanup
  runner.section("Cleanup");

  await runner.test("Delete ontology (cascade)", async () => {
    const { status } = await api("DELETE", `/api/v2/ontologies/${ctx.ontologyId}`);
    runner.assert(status === 204, `Expected 204, got ${status}`);
  });

  // Clean files
  try { fs.unlinkSync(ctx.employeeCsvPath); } catch {}

  runner.summary("Saturday Integration");
  stopServer();
  process.exit(runner.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
