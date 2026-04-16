// ---------------------------------------------------------------------------
// Integration: Ontology CRUD (Tasks 1, 2, 11, 12, 19)
// ---------------------------------------------------------------------------

import { Runner } from "../../helpers/runner";
import { api } from "../../helpers/api";
import { TestContext } from "./context";

export async function run(t: Runner, ctx: TestContext): Promise<void> {
  t.section("Core: Server, DB, Migrations (Tasks 1-6)");

  await t.test("Health check (Task 1)", async () => {
    const { status, body } = await api("GET", "/health");
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.status === "healthy", `Expected "healthy", got "${body.status}"`);
    t.assert(body.database === "connected", `Expected "connected"`);
    t.assert(typeof body.timestamp === "string", "Expected timestamp string");
  });

  await t.test("Create ontology (Task 2)", async () => {
    const { status, body } = await api("POST", "/api/v1/ontologies", {
      displayName: "Test Ontology",
      description: "Integration test ontology",
    });
    t.assert(status === 201, `Expected 201, got ${status}`);
    t.assert(typeof body.ontologyId === "string", "Expected ontologyId string");
    t.assert(/^[0-9a-f]{8}-[0-9a-f]{4}/.test(body.ontologyId), "UUID format");
    t.assert(body.displayName === "Test Ontology", "displayName matches");
    t.assert(body.description === "Integration test ontology", "description matches");
    t.assert(body.objectTypeCount === 0, "objectTypeCount = 0");
    t.assert(typeof body.createdAt === "string", "createdAt present");
    t.assert(typeof body.updatedAt === "string", "updatedAt present");
    ctx.ontologyId = body.ontologyId;
  });

  await t.test("Duplicate ontology fails (Task 2)", async () => {
    const { status, body } = await api("POST", "/api/v1/ontologies", {
      displayName: "Test Ontology",
    });
    t.assert(status === 409, `Expected 409, got ${status}`);
    t.assert(body.error.code === "ONTOLOGY_ALREADY_EXISTS", `code = ${body.error.code}`);
  });

  await t.test("List ontologies with pagination (Task 11/12)", async () => {
    const { status, body } = await api("GET", "/api/v1/ontologies?pageSize=10");
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(Array.isArray(body.data), "data is array");
    t.assert(body.data.length >= 1, "at least 1 ontology");
    t.assert(typeof body.totalCount === "number", "totalCount is number");
    t.assert(typeof body.pageSize === "number", "pageSize is number");
  });

  await t.test("Get ontology by ID (Task 11/12)", async () => {
    const { status, body } = await api("GET", `/api/v1/ontologies/${ctx.ontologyId}`);
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(body.displayName === "Test Ontology", "displayName matches");
  });

  t.section("Validation Middleware (Task 19)");

  await t.test("validateBody rejects missing required fields (Task 19)", async () => {
    const { status, body } = await api("POST", "/api/v1/ontologies", {});
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "VALIDATION_FAILED", `code = ${body.error.code}`);
    t.assert(body.error.message.includes("displayName"), "mentions displayName");
  });

  await t.test("Invalid UUID rejected (Task 9)", async () => {
    const { status, body } = await api("GET", "/api/v1/ontologies/not-a-uuid");
    t.assert(status === 400, `Expected 400, got ${status}`);
    t.assert(body.error.code === "INVALID_PARAMETER", `code = ${body.error.code}`);
  });
}
