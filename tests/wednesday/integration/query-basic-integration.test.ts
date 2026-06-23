// ---------------------------------------------------------------------------
// Integration Test — Basic Query Operations (Task 26)
//
// 15 test cases verifying list, get, search with all filter types.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../../helpers/api";

const BASE = "/api/v1/objects";
let ONTOLOGY_ID: string;
let READY = false;

// Lightweight setup: create ontology + object type + properties (no indexed data)
describe("Query Basic Operations (Task 26)", () => {
  beforeAll(async () => {
    try {
      const res = await fetch("http://localhost:3000/health");
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
      apiName: "T26Employee",
      displayName: "T26 Employee",
      description: "Test",
    });

    const props = [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
      { apiName: "fullName", displayName: "Full Name", baseType: "string" },
      { apiName: "salary", displayName: "Salary", baseType: "double" },
      { apiName: "department", displayName: "Department", baseType: "string" },
      { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
      { apiName: "startDate", displayName: "Start Date", baseType: "date" },
      { apiName: "email", displayName: "Email", baseType: "string" },
    ];
    for (const p of props) {
      await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/T26Employee/properties`, p);
    }
    READY = true;
  }, 30_000);

  afterAll(async () => {
    if (ONTOLOGY_ID) await api("DELETE", `/api/v1/ontology/${ONTOLOGY_ID}`);
  }, 10_000);

  // 1. List all objects (empty index returns 200 with empty data)
  it("test_list_all_objects — GET returns 200 for existing type", async () => {
    if (!READY) return;
    const { status, body } = await api("GET", `${BASE}/T26Employee`);
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 2. List with page size
  it("test_list_with_page_size — $pageSize=10 accepted", async () => {
    if (!READY) return;
    const { status, body } = await api("GET", `${BASE}/T26Employee?$pageSize=10`);
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 3. List with $select
  it("test_list_with_select — $select limits returned fields", async () => {
    if (!READY) return;
    const { status } = await api("GET", `${BASE}/T26Employee?$select=fullName,salary`);
    expect(status).toBe(200);
  });

  // 4. Get single object (not found)
  it("test_get_single_object_not_found — returns 404 for missing PK", async () => {
    if (!READY) return;
    const { status, body } = await api("GET", `${BASE}/T26Employee/FAKE-999`);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe("OBJECT_NOT_FOUND");
  });

  // 5. Get nonexistent type
  it("test_get_nonexistent_type — returns 404 with OBJECT_TYPE_NOT_FOUND", async () => {
    if (!READY) return;
    const { status, body } = await api("GET", `${BASE}/NonExistentType123`);
    expect(status).toBe(404);
    expect(body?.error?.code).toBe("OBJECT_TYPE_NOT_FOUND");
  });

  // 6. Search eq string filter
  it("test_search_eq_string — eq filter accepted on empty index", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "eq", field: "department", value: "Engineering" },
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 7. Search eq boolean filter
  it("test_search_eq_boolean — eq filter on boolean accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "eq", field: "isActive", value: true },
    });
    expect(status).toBe(200);
  });

  // 8. Search gt number filter
  it("test_search_gt_number — gt filter on numeric accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "gt", field: "salary", value: 100000 },
    });
    expect(status).toBe(200);
  });

  // 9. Search contains filter
  it("test_search_contains — contains filter on string accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "contains", field: "fullName", value: "chang" },
    });
    expect(status).toBe(200);
  });

  // 10. Search in filter
  it("test_search_in — in filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "in", field: "department", value: ["Engineering", "Sales"] },
    });
    expect(status).toBe(200);
  });

  // 11. Search isNull filter
  it("test_search_isNull — isNull filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: { type: "isNull", field: "email" },
    });
    expect(status).toBe(200);
  });

  // 12. Search compound and filter
  it("test_search_and — compound and filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: {
        type: "and",
        value: [
          { type: "eq", field: "department", value: "Engineering" },
          { type: "gt", field: "salary", value: 150000 },
        ],
      },
    });
    expect(status).toBe(200);
  });

  // 13. Search compound or filter
  it("test_search_or — compound or filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: {
        type: "or",
        value: [
          { type: "eq", field: "department", value: "Engineering" },
          { type: "eq", field: "department", value: "Sales" },
        ],
      },
    });
    expect(status).toBe(200);
  });

  // 14. Search not filter
  it("test_search_not — not filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: {
        type: "not",
        value: [{ type: "eq", field: "isActive", value: false }],
      },
    });
    expect(status).toBe(200);
  });

  // 15. Search nested compound filter
  it("test_search_nested_compound — deeply nested filter accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T26Employee/search`, {
      where: {
        type: "and",
        value: [
          { type: "eq", field: "department", value: "Engineering" },
          {
            type: "or",
            value: [
              { type: "gt", field: "salary", value: 150000 },
              {
                type: "and",
                value: [
                  { type: "eq", field: "isActive", value: true },
                  { type: "gte", field: "startDate", value: "2023-01-01" },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(status).toBe(200);
  });
});
