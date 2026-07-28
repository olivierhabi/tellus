// Unit tests: AggregationV2 builder + parser + accuracy gate.
import { describe, it, expect } from "vitest";
import {
  buildV2Aggs,
  parseV2AggResponse,
  assertAccuracy,
  AggregationError,
} from "../../../src/services/oss/aggregationV2";
import { toV2Error } from "../../../src/services/oss/v2Errors";

const keywordOf = (f: string) => `${f}.keyword`;

describe("buildV2Aggs", () => {
  it("ungrouped → global bucket with metrics", () => {
    const { aggs, metricNames } = buildV2Aggs(
      [{ type: "count" }, { type: "avg", field: "salary" }],
      [],
      keywordOf,
    );
    expect(aggs.__all).toBeDefined();
    expect(metricNames).toHaveLength(2);
  });

  it("exact groupBy → terms with maxGroupCount and missing", () => {
    const { aggs } = buildV2Aggs(
      [{ type: "count" }],
      [{ type: "exact", field: "dept", maxGroupCount: 50, includeNullValues: true, defaultValue: "N/A" }],
      keywordOf,
    );
    const dept = aggs.dept as { terms: Record<string, unknown> };
    expect(dept.terms.field).toBe("dept.keyword");
    expect(dept.terms.size).toBe(50);
    expect(dept.terms.missing).toBe("N/A");
  });

  it("duration groupBy: calendar units require value=1 (verified)", () => {
    expect(() =>
      buildV2Aggs([{ type: "count" }], [{ type: "duration", field: "d", value: 2, unit: "MONTHS" }], keywordOf),
    ).toThrowError(AggregationError);
    const { aggs } = buildV2Aggs(
      [{ type: "count" }],
      [{ type: "duration", field: "d", value: 1, unit: "MONTHS" }],
      keywordOf,
    );
    expect((aggs.d as { date_histogram: Record<string, unknown> }).date_histogram.calendar_interval).toBe("month");
  });

  it("exactDistinct uses high precision; approximateDistinct default", () => {
    const { aggs } = buildV2Aggs(
      [{ type: "exactDistinct", field: "f" }, { type: "approximateDistinct", field: "g" }],
      [],
      keywordOf,
    );
    const all = (aggs.__all as { aggs: Record<string, { cardinality: Record<string, unknown> }> }).aggs;
    const names = Object.values(all).map((a) => a.cardinality);
    expect(names.some((c) => c.precision_threshold === 40000)).toBe(true);
    expect(names.some((c) => c.precision_threshold === undefined)).toBe(true);
  });

  it("approximatePercentile → percentiles agg", () => {
    const { aggs } = buildV2Aggs(
      [{ type: "approximatePercentile", field: "salary", approximatePercentile: 95, name: "p95" }],
      [],
      keywordOf,
    );
    const all = (aggs.__all as { aggs: Record<string, unknown> }).aggs;
    expect(all.p95).toMatchObject({ percentiles: { percents: [95] } });
  });
});

describe("parseV2AggResponse + accuracy", () => {
  it("parses nested group buckets into flat items", () => {
    const parsed = parseV2AggResponse(
      {
        dept: {
          buckets: [
            {
              key: "Eng",
              doc_count: 2,
              metric: { value: 100 },
            },
          ],
        },
      },
      [{ type: "exact", field: "dept" }],
      ["metric"],
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].group).toEqual({ dept: "Eng" });
    expect(parsed.items[0].metrics[0]).toEqual({ name: "metric", value: 100 });
    expect(parsed.approximate).toBe(false);
  });

  it("truncated terms → approximate + excludedItems", () => {
    const parsed = parseV2AggResponse(
      {
        dept: {
          sum_other_doc_count: 7,
          buckets: [{ key: "Eng", doc_count: 2, c: { value: 2 } }],
        },
      },
      [{ type: "exact", field: "dept" }],
      ["c"],
    );
    expect(parsed.approximate).toBe(true);
    expect(parsed.excludedItems).toBe(7);
    expect(assertAccuracy(parsed, "ALLOW_APPROXIMATE")).toBe("APPROXIMATE");
    expect(assertAccuracy(parsed, undefined)).toBe("APPROXIMATE");
  });

  it("REQUIRE_ACCURATE + truncation → AggregationAccuracyNotSupported (verified error)", () => {
    const parsed = parseV2AggResponse(
      { dept: { sum_other_doc_count: 3, buckets: [] } },
      [{ type: "exact", field: "dept" }],
      ["c"],
    );
    try {
      assertAccuracy(parsed, "REQUIRE_ACCURATE");
      expect.unreachable("must throw");
    } catch (e) {
      expect((e as AggregationError).errorName).toBe(
        "AggregationAccuracyNotSupported",
      );
    }
  });

  it("exact results → ACCURATE", () => {
    const parsed = parseV2AggResponse(
      { dept: { buckets: [{ key: "A", doc_count: 1, c: { value: 1 } }] } },
      [{ type: "exact", field: "dept" }],
      ["c"],
    );
    expect(assertAccuracy(parsed, "REQUIRE_ACCURATE")).toBe("ACCURATE");
  });
});

describe("v2 error translation", () => {
  it("classifies an unavailable search backend as retryable service failure", () => {
    const { status, body } = toV2Error(
      Object.assign(new Error("Object Storage is temporarily unavailable."), {
        errorName: "SearchBackendUnavailable",
        statusCode: 503,
        parameters: { retryable: true },
      }),
    );
    expect(status).toBe(503);
    expect(body.errorName).toBe("SearchBackendUnavailable");
    expect(body.parameters.retryable).toBe(true);
  });

  it("maps typed errors to the v2 envelope", () => {
    const { status, body } = toV2Error(
      Object.assign(new Error("nope"), {
        errorName: "AggregationAccuracyNotSupported",
        parameters: { excludedItems: 5 },
      }),
    );
    expect(status).toBe(400);
    expect(body.errorCode).toBe("INVALID_ARGUMENT");
    expect(body.errorName).toBe("AggregationAccuracyNotSupported");
    expect(body.errorInstanceId).toBeTruthy();
    expect(body.parameters.excludedItems).toBe(5);
  });

  it("maps legacy v1 codes (preserved, translated only at v2 boundary)", () => {
    const { status, body } = toV2Error(
      Object.assign(new Error("missing"), { code: "OBJECT_TYPE_NOT_FOUND" }),
    );
    expect(status).toBe(404);
    expect(body.errorName).toBe("ObjectTypeNotFound");
  });

  it("unknown errors → 500 InternalError without leaking details", () => {
    const { status, body } = toV2Error(new Error("db secret detail"));
    expect(status).toBe(500);
    expect(body.errorName).toBe("InternalError");
    expect(JSON.stringify(body.parameters)).not.toContain("db secret detail");
  });
});
