import { describe, expect, it } from "vitest";

import {
  collectBulkFailures,
  formatBulkFailures,
} from "../../../src/services/serving/bulkResult";

describe("collectBulkFailures", () => {
  it("returns only genuine failures, excusing delete-404 idempotency", () => {
    const failures = collectBulkFailures([
      { index: { status: 201, _id: "EVD-1", result: "created" } },
      { index: { status: 400, _id: "EVD-bad", error: { reason: "id too long" } } },
      { delete: { status: 404, _id: "EVD-gone", result: "not_found" } },
      { delete: { status: 500, _id: "EVD-del-fail", result: "error" } },
    ]);
    expect(failures.map((f) => f.id)).toEqual(["EVD-bad", "EVD-del-fail"]);
  });

  it("tolerates missing items", () => {
    expect(collectBulkFailures(undefined)).toEqual([]);
    expect(collectBulkFailures(null)).toEqual([]);
    expect(collectBulkFailures([])).toEqual([]);
  });
});

describe("formatBulkFailures", () => {
  it("truncates giant ids instead of dumping them into logs", () => {
    const giant = `EVD${"0".repeat(12000)}1000001`;
    const summary = formatBulkFailures([{ id: giant, status: 400, reason: "id too long" }]);
    expect(summary.length).toBeLessThan(200);
    expect(summary).toContain(`(${giant.length})`);
  });
});
