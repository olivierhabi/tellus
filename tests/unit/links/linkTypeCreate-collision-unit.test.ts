/**
 * linkType.create — apiName collision modes
 *
 * Pins the contract that fixes the CI tuesday/integration regression
 * "Duplicate link type creation returns 409 — Expected 409, got 201".
 *
 * Two modes for the INSERT-time UNIQUE collision:
 *
 *   (a) Caller did NOT provide `apiName` → derived from `displayName`.
 *       Treated as a UX collision; auto-disambiguate by appending a
 *       numeric suffix and retry. Caller never sees an error.
 *
 *   (b) Caller PROVIDED an explicit `apiName`. Treated as an identity
 *       collision; throw `ALREADY_EXISTS` (HTTP 409) immediately. No
 *       silent rename.
 *
 * Implemented in src/models/linkType.ts:283-376.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const queryMock = vi.fn();
const getClientMock = vi.fn();

vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
  getClient: (...args: unknown[]) => getClientMock(...args),
}));

// Stub the helpers that hit the DB to resolve OT/property IDs.
vi.mock("../../../src/utils/apiNameValidator", () => ({
  validateLinkTypeName: () => ({ valid: true }),
}));

const ONTOLOGY_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_OT_ID = "22222222-2222-2222-2222-222222222222";
const TARGET_OT_ID = "33333333-3333-3333-3333-333333333333";
const SOURCE_PROP_ID = "44444444-4444-4444-4444-444444444444";
const TARGET_PROP_ID = "55555555-5555-5555-5555-555555555555";

function uniqueViolation(): Error {
  const e: Error & { code?: string } = new Error('duplicate key value violates unique constraint');
  e.code = "23505";
  return e;
}

function buildOtAndPropertyResolvers(): void {
  // resolveObjectTypeId × 2, resolvePropertyId × 2 — fixed answers.
  queryMock
    .mockResolvedValueOnce({ rows: [{ object_type_id: SOURCE_OT_ID }] })
    .mockResolvedValueOnce({ rows: [{ object_type_id: TARGET_OT_ID }] })
    .mockResolvedValueOnce({ rows: [{ property_id: SOURCE_PROP_ID }] })
    .mockResolvedValueOnce({ rows: [{ property_id: TARGET_PROP_ID }] });
}

beforeEach(() => {
  queryMock.mockReset();
  getClientMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("linkType.create — apiName collision modes", () => {
  it("CALLER-PROVIDED apiName + UNIQUE violation → throws ALREADY_EXISTS (HTTP 409 mode)", async () => {
    buildOtAndPropertyResolvers();
    queryMock.mockRejectedValueOnce(uniqueViolation());

    const { create } = await import("../../../src/models/linkType");
    await expect(
      create(ONTOLOGY_ID, {
        apiName: "companyEmployees",
        displayName: "Company Employees",
        cardinality: "ONE_TO_MANY",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "Employee",
        sourcePropertyApiName: "companyId",
        targetPropertyApiName: "employeeId",
      })
    ).rejects.toMatchObject({
      code: "ALREADY_EXISTS",
      message: expect.stringContaining("companyEmployees"),
    });

    // Exactly ONE INSERT attempt — no auto-disambiguation when caller
    // explicitly named the link.
    const insertCalls = queryMock.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /INSERT INTO link_type/i.test(sql)
    );
    expect(insertCalls).toHaveLength(1);
  });

  it("DERIVED apiName + UNIQUE violation → silently retries with numeric suffix", async () => {
    buildOtAndPropertyResolvers();
    // First INSERT collides, second succeeds.
    queryMock
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({
        rows: [{ link_type_id: "lt-1", api_name: "companyEmployees2" }],
      });

    const { create } = await import("../../../src/models/linkType");
    const row = await create(ONTOLOGY_ID, {
      // No apiName — derived from displayName "Company Employees" → "companyEmployees".
      displayName: "Company Employees",
      cardinality: "ONE_TO_MANY",
      sourceObjectTypeApiName: "Company",
      targetObjectTypeApiName: "Employee",
      sourcePropertyApiName: "companyId",
      targetPropertyApiName: "employeeId",
    });

    expect(row).toMatchObject({ api_name: "companyEmployees2" });

    // Two INSERT attempts: first with "companyEmployees", second with "companyEmployees2".
    const insertCalls = queryMock.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /INSERT INTO link_type/i.test(sql)
    );
    expect(insertCalls).toHaveLength(2);
    // 2nd-arg position 1 = api_name
    expect(insertCalls[0][1][1]).toBe("companyEmployees");
    expect(insertCalls[1][1][1]).toBe("companyEmployees2");
  });

  it("non-UNIQUE PG error propagates verbatim (no rewrite to ALREADY_EXISTS)", async () => {
    buildOtAndPropertyResolvers();
    const otherErr: Error & { code?: string } = new Error("connection terminated");
    otherErr.code = "57P01";
    queryMock.mockRejectedValueOnce(otherErr);

    const { create } = await import("../../../src/models/linkType");
    await expect(
      create(ONTOLOGY_ID, {
        apiName: "companyEmployees",
        displayName: "Company Employees",
        cardinality: "ONE_TO_MANY",
        sourceObjectTypeApiName: "Company",
        targetObjectTypeApiName: "Employee",
        sourcePropertyApiName: "companyId",
        targetPropertyApiName: "employeeId",
      })
    ).rejects.toMatchObject({ code: "57P01" });
  });
});
