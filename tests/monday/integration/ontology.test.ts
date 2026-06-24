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

  // "One Enterprise, One Ontology": creating ontologies is frozen. The create
  // endpoint returns 409 ONTOLOGY_SINGLETON; tests resolve the single canonical
  // ontology via the `default` alias instead.
  await t.test("Create ontology is frozen (single-ontology)", async () => {
    const { status, body } = await api("POST", "/api/v1/ontology", {
      displayName: "Test Ontology",
      description: "Integration test ontology",
    });
    t.assert(status === 409, `Expected 409, got ${status}`);
    t.assert(body.error.code === "ONTOLOGY_SINGLETON", `code = ${body.error?.code}`);

    // Resolve the canonical ontology for downstream tests.
    const got = await api("GET", "/api/v1/ontology/default");
    t.assert(got.status === 200, `Expected 200, got ${got.status}`);
    ctx.ontologyId = got.body.ontologyId ?? got.body?.data?.ontologyId;
    t.assert(typeof ctx.ontologyId === "string", "Expected canonical ontologyId");
  });

  await t.test("List returns exactly one ontology (single-ontology)", async () => {
    const { status, body } = await api("GET", "/api/v1/ontology?pageSize=10");
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(Array.isArray(body.data), "data is array");
    t.assert(body.data.length === 1, "exactly 1 ontology");
    t.assert(typeof body.totalCount === "number", "totalCount is number");
    t.assert(typeof body.pageSize === "number", "pageSize is number");
  });

  await t.test("Get ontology by ID (Task 11/12)", async () => {
    const { status, body } = await api("GET", `/api/v1/ontology/${ctx.ontologyId}`);
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(typeof body.displayName === "string", "displayName present");
  });

  t.section("Validation Middleware (Task 19)");

  await t.test("Create endpoint is frozen regardless of body (single-ontology)", async () => {
    // The create route no longer validates a body — it is frozen, so any POST
    // (even an empty one) returns 409 ONTOLOGY_SINGLETON.
    const { status, body } = await api("POST", "/api/v1/ontology", {});
    t.assert(status === 409, `Expected 409, got ${status}`);
    t.assert(body.error.code === "ONTOLOGY_SINGLETON", `code = ${body.error?.code}`);
  });

  await t.test("Any ontology id collapses to the canonical ontology (single-ontology)", async () => {
    // The edge collapse rewrites ANY :ontologyId (even a non-UUID) to the one
    // enterprise ontology, so this resolves instead of 404/400.
    const { status, body } = await api("GET", "/api/v1/ontology/not-a-uuid");
    t.assert(status === 200, `Expected 200, got ${status}`);
    t.assert(typeof body.ontologyId === "string", "resolved to the canonical ontology");
  });
}
