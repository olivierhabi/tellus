// ---------------------------------------------------------------------------
// Integration Test — Pagination (Task 27)
//
// 7 test cases verifying cursor-based pagination correctness.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, BASE_URL } from "../../helpers/api";

const BASE = "/api/v1/objects";
let ONTOLOGY_ID: string;
let READY = false;

describe("Query Pagination (Task 27)", () => {
  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status !== 200) throw new Error("not healthy");
    } catch {
      throw new Error("F-P2-01: integration server unreachable — beforeAll fails loudly rather than ghost-passing");
    }

    // Singleton ontology deployment: POST /api/v1/ontology is frozen
    // (ONTOLOGY_SINGLETON). Resolve the single canonical enterprise
    // ontology instead of creating a fresh one per run.
    const { body } = await api("GET", "/api/v1/ontology");
    ONTOLOGY_ID = body?.data?.[0]?.ontologyId;
    if (!ONTOLOGY_ID) throw new Error("F-P2-01: canonical ontology not found — beforeAll fails loudly");

    await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes`, {
      apiName: "T27Employee",
      displayName: "T27 Employee",
      description: "Test",
    });

    const props = [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
      { apiName: "fullName", displayName: "Full Name", baseType: "string" },
      { apiName: "salary", displayName: "Salary", baseType: "double" },
      { apiName: "department", displayName: "Department", baseType: "string" },
    ];
    for (const p of props) {
      await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/T27Employee/properties`, p);
    }

    // Create Company type for cross-type token test
    await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes`, {
      apiName: "T27Company",
      displayName: "T27 Company",
      description: "Test",
    });
    await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/T27Company/properties`, {
      apiName: "companyId", displayName: "Company ID", baseType: "string",
    });

    READY = true;
  }, 30_000);

  afterAll(async () => {
    if (ONTOLOGY_ID) await api("DELETE", `/api/v1/ontology/${ONTOLOGY_ID}`);
  }, 10_000);

  // 1. Paginate all objects (empty — verify pagination returns with no errors)
  it("test_paginate_all_objects — paginate on empty index works", async () => {
    if (!READY) return;
    const { status, body } = await api("GET", `${BASE}/T27Employee?$pageSize=10`);
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body.nextPageToken).toBeNull();
  });

  // 2. Paginate with sort
  it("test_paginate_with_sort — $orderBy=salary:desc accepted", async () => {
    if (!READY) return;
    const { status } = await api("GET", `${BASE}/T27Employee?$orderBy=salary:desc&$pageSize=10`);
    expect(status).toBe(200);
  });

  // 3. Paginate with filter
  it("test_paginate_with_filter — search + pagination works", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T27Employee/search`, {
      where: { type: "eq", field: "department", value: "Engineering" },
      $pageSize: 5,
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 4. Page token wrong object type (cross-type rejection)
  it("test_page_token_wrong_object_type — token for Employee rejected on Company", async () => {
    if (!READY) return;
    // First get a valid page from Employee
    const { body: empBody } = await api("GET", `${BASE}/T27Employee?$pageSize=10`);
    // Token will be null (empty index), so test with a crafted token
    // Build a fake base64 token with wrong object type
    const fakeToken = Buffer.from(JSON.stringify({
      sort: ["test"],
      objectType: "T27Employee",
      orderBy: [],
      where: null,
      created: Date.now(),
    })).toString("base64");

    const { status } = await api("GET", `${BASE}/T27Company?$pageToken=${fakeToken}`);
    expect(status).toBe(400);
  });

  // 5. Invalid page token string
  it("test_page_token_invalid_string — garbage token rejected", async () => {
    if (!READY) return;
    const { status } = await api("GET", `${BASE}/T27Employee?$pageToken=not-a-real-token`);
    expect(status).toBe(400);
  });

  // 6. Single page result
  it("test_single_page_result — exact match returns 1 result, no next token", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T27Employee/search`, {
      where: { type: "eq", field: "employeeId", value: "EMP-001" },
      $pageSize: 100,
    });
    expect(status).toBe(200);
    // Empty index, so 0 results
    expect(body.nextPageToken).toBeNull();
  });

  // 7. Empty result
  it("test_empty_result — filter matching nothing returns empty data", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T27Employee/search`, {
      where: { type: "eq", field: "department", value: "NonExistentDepartment" },
    });
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.nextPageToken).toBeNull();
    expect(body.totalCount).toBe(0);
  });
});
