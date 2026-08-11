import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../src/db", () => ({ query: queryMock }));

import { inlineSource } from "../../../src/qa/rwanda/functionsV2";
import { evaluateFunctionValidationCriteria } from "../../../src/actions/functionValidationCriteria";

describe("pinned function-backed action validation", () => {
  beforeEach(() => queryMock.mockReset());

  it("accepts and rejects using the immutable configured version", async () => {
    queryMock.mockResolvedValue({ rowCount: 1, rows: [{ source_code: inlineSource("validateCreditLimitV2") }] });
    const criteria = { conditions: [{
      functionValidation: {
        apiName: "validateCreditLimitV2",
        version: 2,
        input: {
          requestedLimit: { source: "parameter", parameter: "limit" },
          policyCeiling: { source: "static", value: 1_000_000 },
        },
        resultField: "allowed",
      },
      description: "credit limit rejected",
    }] };
    await expect(evaluateFunctionValidationCriteria("o1", criteria, { limit: 500_000 })).resolves.toEqual([]);
    await expect(evaluateFunctionValidationCriteria("o1", criteria, { limit: 2_000_000 })).resolves.toEqual([
      "credit limit rejected: requestedLimit exceeds policy ceiling 1000000",
    ]);
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("v.version_number = $3"), ["o1", "validateCreditLimitV2", 2]);
  });

  it("fails closed when the pinned version is unavailable", async () => {
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(evaluateFunctionValidationCriteria("o1", { conditions: [{
      functionValidation: { apiName: "missing", version: 7, input: {}, resultField: "allowed" },
    }] }, {})).resolves.toEqual(["Pinned function missing@7 is unavailable"]);
  });
});
