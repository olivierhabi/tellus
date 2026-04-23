/**
 * Task 29 — OpenAPI Specification Integration Tests
 *
 * Verifies that the /api/docs/spec.json and /api/docs endpoints serve the
 * correct OpenAPI specification and Swagger UI documentation.
 */
import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Skip helper — gracefully skip when server is not running
// ---------------------------------------------------------------------------
async function skipIfNoServer(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`health probe returned ${res.status}`);
    return false; // server reachable, do not skip
  } catch (err) {
    throw new Error(
      "F-P2-01: integration server unreachable at " + BASE +
      " — beforeAll fails loudly rather than ghost-passing. " +
      "Root cause: " + ((err as Error)?.message || err)
    );
  }
}/health`, { signal: AbortSignal.timeout(2000) });
    return !res.ok;
  } catch {
    return true;
  }
}

describe("Task 29 — OpenAPI Specification", () => {
  let skip = false;

  beforeAll(async () => {
    skip = await skipIfNoServer();
  });

  // -----------------------------------------------------------------------
  // 1. GET /api/docs/spec.json returns 200
  // -----------------------------------------------------------------------
  it("should return 200 from /api/docs/spec.json", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // 2. /api/docs/spec.json returns valid JSON with openapi field
  // -----------------------------------------------------------------------
  it("should return valid JSON with openapi version", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.0.3");
  });

  // -----------------------------------------------------------------------
  // 3. Spec contains info block with title and version
  // -----------------------------------------------------------------------
  it("should include info block with title and version", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain("Tellus");
    expect(spec.info.version).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 4. Spec contains Actions API paths (merged from actions.openapi.json)
  // -----------------------------------------------------------------------
  it("should contain all expected Actions API paths", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    const paths = Object.keys(spec.paths);

    // Paths in the spec are relative to the server base URL (`/api`),
    // so they start with `/v1/...` not `/api/v1/...`.
    const expectedPaths = [
      "/v1/ontology/{ontologyId}/actionTypes",
      "/v1/ontology/{ontologyId}/actionTypes/{actionApiName}",
      "/v1/ontology/{ontologyId}/actionTypes/{actionApiName}/clone",
      "/v1/ontology/{ontologyId}/actionTypes/{actionApiName}/impact",
      "/v1/ontology/{ontologyId}/actions/{actionTypeApiName}/apply",
      "/v1/ontology/{ontologyId}/actions/{actionTypeApiName}/validate",
      "/v1/ontology/{ontologyId}/actions/{actionTypeApiName}/applyBatch",
      "/v1/ontology/{ontologyId}/actions/{actionTypeApiName}/audit",
      "/v1/audit/log",
      "/v1/audit/log/{executionId}",
      "/v1/audit/stats",
      "/v1/objects/{objectType}/{primaryKey}/editHistory",
    ];

    for (const p of expectedPaths) {
      expect(paths).toContain(p);
    }
  });

  // -----------------------------------------------------------------------
  // 5. Spec contains reusable component schemas
  // -----------------------------------------------------------------------
  it("should define reusable component schemas", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    const schemas = Object.keys(spec.components?.schemas ?? {});

    const expectedSchemas = [
      "ActionTypeDefinition",
      "ActionParameter",
      "ActionRule",
      "ActionExecutionResult",
      "AuditLogEntry",
      "OntologyError",
      "BatchExecutionResult",
      "ValidationResultSuccess",
      "ValidationResultFailure",
      "AuditStats",
      "EditHistoryEntry",
      "ImpactAnalysis",
    ];

    for (const s of expectedSchemas) {
      expect(schemas).toContain(s);
    }
  });

  // -----------------------------------------------------------------------
  // 6. Action types path has POST, GET methods
  // -----------------------------------------------------------------------
  it("should define POST and GET on actionTypes path", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    const methods = Object.keys(
      spec.paths["/v1/ontology/{ontologyId}/actionTypes"] ?? {}
    );
    expect(methods).toContain("post");
    expect(methods).toContain("get");
  });

  // -----------------------------------------------------------------------
  // 7. Single action type path has GET, PUT, DELETE methods
  // -----------------------------------------------------------------------
  it("should define GET, PUT, DELETE on single actionType path", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    const methods = Object.keys(
      spec.paths["/v1/ontology/{ontologyId}/actionTypes/{actionApiName}"] ?? {}
    );
    expect(methods).toContain("get");
    expect(methods).toContain("put");
    expect(methods).toContain("delete");
  });

  // -----------------------------------------------------------------------
  // 8. Spec includes tags for categorization
  // -----------------------------------------------------------------------
  it("should include tags for endpoint categorization", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const spec = await res.json();
    expect(Array.isArray(spec.tags)).toBe(true);
    const tagNames = spec.tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain("Action Types");
    expect(tagNames).toContain("Action Execution");
    expect(tagNames).toContain("Audit Log");
    expect(tagNames).toContain("Edit History");
  });

  // -----------------------------------------------------------------------
  // 9. GET /api/docs returns HTML (Swagger UI)
  // -----------------------------------------------------------------------
  it("should serve Swagger UI HTML at /api/docs", async () => {
    const res = await fetch(`${BASE}/api/docs`, {
      redirect: "follow",
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("swagger-ui");
  });

  // -----------------------------------------------------------------------
  // 10. Spec content-type is application/json
  // -----------------------------------------------------------------------
  it("should return application/json content-type for /api/docs/spec.json", async () => {
    const res = await fetch(`${BASE}/api/docs/spec.json`);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });
});
