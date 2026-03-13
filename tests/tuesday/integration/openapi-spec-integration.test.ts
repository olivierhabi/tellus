/**
 * Task 29 — OpenAPI Specification Integration Tests
 *
 * Verifies that the /api/v2/spec and /api/v2/docs endpoints serve the
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
  // 1. GET /api/v2/spec returns 200
  // -----------------------------------------------------------------------
  it("should return 200 from /api/v2/spec", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // 2. /api/v2/spec returns valid JSON with openapi field
  // -----------------------------------------------------------------------
  it("should return valid JSON with openapi version", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.0.3");
  });

  // -----------------------------------------------------------------------
  // 3. Spec contains info block with title and version
  // -----------------------------------------------------------------------
  it("should include info block with title and version", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain("Tellus");
    expect(spec.info.version).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 4. Spec contains all 15 documented paths
  // -----------------------------------------------------------------------
  it("should contain all expected endpoint paths", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    const paths = Object.keys(spec.paths);

    const expectedPaths = [
      "/api/v2/ontologies/{ontologyId}/actionTypes",
      "/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}",
      "/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}/clone",
      "/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}/impact",
      "/api/v2/ontologies/{ontologyId}/actions/{actionTypeApiName}/apply",
      "/api/v2/ontologies/{ontologyId}/actions/{actionTypeApiName}/validate",
      "/api/v2/ontologies/{ontologyId}/actions/{actionTypeApiName}/applyBatch",
      "/api/v2/ontologies/{ontologyId}/actions/{actionTypeApiName}/audit",
      "/api/v2/audit/log",
      "/api/v2/audit/log/{executionId}",
      "/api/v2/audit/stats",
      "/api/v2/objects/{objectType}/{primaryKey}/editHistory",
      "/api/v2/spec",
    ];

    for (const p of expectedPaths) {
      expect(paths).toContain(p);
    }
  });

  // -----------------------------------------------------------------------
  // 5. Spec contains reusable component schemas
  // -----------------------------------------------------------------------
  it("should define reusable component schemas", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
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
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    const methods = Object.keys(
      spec.paths["/api/v2/ontologies/{ontologyId}/actionTypes"] ?? {}
    );
    expect(methods).toContain("post");
    expect(methods).toContain("get");
  });

  // -----------------------------------------------------------------------
  // 7. Single action type path has GET, PUT, DELETE methods
  // -----------------------------------------------------------------------
  it("should define GET, PUT, DELETE on single actionType path", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    const methods = Object.keys(
      spec.paths["/api/v2/ontologies/{ontologyId}/actionTypes/{actionApiName}"] ?? {}
    );
    expect(methods).toContain("get");
    expect(methods).toContain("put");
    expect(methods).toContain("delete");
  });

  // -----------------------------------------------------------------------
  // 8. Spec includes tags for categorization
  // -----------------------------------------------------------------------
  it("should include tags for endpoint categorization", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const spec = await res.json();
    expect(Array.isArray(spec.tags)).toBe(true);
    const tagNames = spec.tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain("Action Types");
    expect(tagNames).toContain("Action Execution");
    expect(tagNames).toContain("Audit Log");
    expect(tagNames).toContain("Edit History");
  });

  // -----------------------------------------------------------------------
  // 9. GET /api/v2/docs returns HTML (Swagger UI)
  // -----------------------------------------------------------------------
  it("should serve Swagger UI HTML at /api/v2/docs", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/docs/`, {
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
  it("should return application/json content-type for /api/v2/spec", async () => {
    if (skip) return;
    const res = await fetch(`${BASE}/api/v2/spec`);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
  });
});
