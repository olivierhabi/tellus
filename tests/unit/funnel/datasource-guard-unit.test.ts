// ---------------------------------------------------------------------------
// Datasource merge-budget guard — unit test.
//
// The legacy reindex path must refuse cleanly at 2M+1 distinct PKs with a
// 413 REINDEX_TOO_LARGE naming the type/count/route — never OOM the API.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import { assertDatasourceMergeBudget } from "../../../src/services/reindexService";
import { ERROR_CODES } from "../../../src/utils/responseFormatter";
import { STANDARD_ERROR_CODES } from "../../../src/utils/queryErrors";

describe("assertDatasourceMergeBudget", () => {
  it("passes at and below the limit", () => {
    expect(() =>
      assertDatasourceMergeBudget(2_000_000, 2_000_000, "Account"),
    ).not.toThrow();
    expect(() => assertDatasourceMergeBudget(0, 2_000_000, "Account")).not.toThrow();
  });

  it("refuses at limit+1 with a 413 naming type, count and route", () => {
    let err: unknown = null;
    try {
      assertDatasourceMergeBudget(2_000_001, 2_000_000, "Account");
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    const e = err as { code?: string; message?: string };
    expect(e.code).toBe("REINDEX_TOO_LARGE");
    expect(e.message).toContain("Account");
    expect(e.message).toContain("2000000");
    expect(e.message).toContain("funnel");
    // The code maps to HTTP 413 in both formatters (not a 500).
    expect(ERROR_CODES["REINDEX_TOO_LARGE"]).toBe(413);
    expect(STANDARD_ERROR_CODES["REINDEX_TOO_LARGE"].status).toBe(413);
  });
});
