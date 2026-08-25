// ---------------------------------------------------------------------------
// Integration Test — Aggregations (Task 28)
//
// 12 test cases verifying all aggregation types and validation.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, BASE_URL } from "../../helpers/api";

const BASE = "/api/v1/objects";
let ONTOLOGY_ID: string;
let READY = false;

describe("Query Aggregations (Task 28)", () => {
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
      apiName: "T28Employee",
      displayName: "T28 Employee",
      description: "Test",
    });

    const props = [
      { apiName: "employeeId", displayName: "Employee ID", baseType: "string" },
      { apiName: "fullName", displayName: "Full Name", baseType: "string" },
      { apiName: "salary", displayName: "Salary", baseType: "double" },
      { apiName: "department", displayName: "Department", baseType: "string" },
      { apiName: "startDate", displayName: "Start Date", baseType: "date" },
      { apiName: "isActive", displayName: "Is Active", baseType: "boolean" },
    ];
    for (const p of props) {
      await api("POST", `/api/v1/ontology/${ONTOLOGY_ID}/objectTypes/T28Employee/properties`, p);
    }

    READY = true;
  }, 30_000);

  afterAll(async () => {
    if (ONTOLOGY_ID) await api("DELETE", `/api/v1/ontology/${ONTOLOGY_ID}`);
  }, 10_000);

  // 1. Count aggregation
  it("test_count — count aggregation returns 200", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "count", name: "total" }],
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 2. Avg aggregation
  it("test_avg — avg on numeric field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "avg", field: "salary", name: "avgSalary" }],
    });
    expect(status).toBe(200);
  });

  // 3. Sum aggregation
  it("test_sum — sum on numeric field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "sum", field: "salary", name: "totalPayroll" }],
    });
    expect(status).toBe(200);
  });

  // 4. Min and Max
  it("test_min_max — min and max on numeric field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [
        { type: "min", field: "salary", name: "minSalary" },
        { type: "max", field: "salary", name: "maxSalary" },
      ],
    });
    expect(status).toBe(200);
  });

  // 5. Terms aggregation
  it("test_terms — terms on string field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "terms", field: "department", name: "byDept", size: 10 }],
    });
    expect(status).toBe(200);
  });

  // 6. Date histogram
  it("test_date_histogram — date_histogram on date field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "date_histogram", field: "startDate", interval: "year", name: "byYear" }],
    });
    expect(status).toBe(200);
  });

  // 7. Range aggregation
  it("test_range — range on numeric field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{
        type: "range", field: "salary", name: "salaryBands",
        ranges: [{ to: 50000 }, { from: 50000, to: 100000 }, { from: 100000, to: 200000 }, { from: 200000 }],
      }],
    });
    expect(status).toBe(200);
  });

  // 8. Cardinality
  it("test_cardinality — cardinality on string field accepted", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "cardinality", field: "department", name: "uniqueDepts" }],
    });
    expect(status).toBe(200);
  });

  // 9. Multiple aggregations
  it("test_multiple_aggregations — 5 aggs in one call accepted", async () => {
    if (!READY) return;
    const { status, body } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [
        { type: "count", name: "total" },
        { type: "avg", field: "salary", name: "avgSalary" },
        { type: "max", field: "salary", name: "maxSalary" },
        { type: "terms", field: "department", name: "byDept" },
        { type: "min", field: "salary", name: "minSalary" },
      ],
    });
    expect(status).toBe(200);
    expect(body).toHaveProperty("data");
  });

  // 10. Aggregation with filter
  it("test_aggregation_with_filter — where clause + count works", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      where: { type: "eq", field: "department", value: "Engineering" },
      aggregations: [{ type: "count", name: "total" }],
    });
    expect(status).toBe(200);
  });

  // 11. Avg on string field — type mismatch
  it("test_avg_on_string_field — avg on string field returns 400", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "avg", field: "fullName", name: "avgName" }],
    });
    expect(status).toBe(400);
  });

  // 12. Date histogram on number field — type mismatch
  it("test_date_histogram_on_number — date_histogram on salary returns 400", async () => {
    if (!READY) return;
    const { status } = await api("POST", `${BASE}/T28Employee/aggregate`, {
      aggregations: [{ type: "date_histogram", field: "salary", interval: "year", name: "byYear" }],
    });
    expect(status).toBe(400);
  });
});
