// ---------------------------------------------------------------------------
// Pie Chart aggregation — terms group-by with a nested metric.
//
// Proves that the `/objects/:type/aggregate` building blocks support the Pie
// Chart's documented aggregation methods (count / sum / avg / min / max /
// approximate-unique-count) PER group-by slice:
//
//   1. `buildAggClause` attaches a `metric` sub-aggregation under a `terms`
//      bucket for every method except `count` (where the bucket's own
//      doc_count already IS the value, so no sub-agg is emitted).
//   2. `formatAggregationResponse` surfaces each bucket's `value` from the
//      nested metric when present, falling back to doc_count otherwise — so
//      the chart can plot one value per slice without branching on method.
//
// Pure-function test: the OpenSearch client + PG layer are mocked only to
// keep `queryExecutor`'s module graph import-safe under vitest.unit.config.ts
// (no Docker); the assertions exercise the two functions directly.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/services/opensearch/client", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/opensearch/client")
  >("../../../src/services/opensearch/client");
  return {
    ...actual,
    client: { search: vi.fn(), count: vi.fn(), get: vi.fn(), indices: { exists: vi.fn() } },
  };
});

vi.mock("../../../src/db", () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(),
}));

vi.mock("../../../src/services/propertyResolver", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/services/propertyResolver")
  >("../../../src/services/propertyResolver");
  return {
    ...actual,
    resolveProperty: vi.fn(async (_objectType: string, field: string) => ({
      apiName: field,
      opensearchKeywordField:
        field === "signalType" || field === "severity" ? `${field}.keyword` : field,
    })),
  };
});

import { client } from "../../../src/services/opensearch/client";
import { buildAggClause, executeAggregate } from "../../../src/services/queryExecutor";
import { formatAggregationResponse } from "../../../src/services/objectResponseFormatter";

const keywordField = (field: string) => `${field}.keyword`;

describe("executeAggregate — ontology-aware OpenSearch fields", () => {
  it("emits signalType.keyword in the final OpenSearch cardinality request", async () => {
    vi.mocked(client.search).mockResolvedValueOnce({
      body: {
        hits: { total: { value: 10 } },
        aggregations: { categoryCount: { value: 3 } },
      },
    } as never);

    await executeAggregate("RssbFraudSignal", {
      aggregations: [{
        name: "categoryCount",
        type: "cardinality",
        field: "signalType",
      }],
    }, null, null);

    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({
      index: expect.any(String),
      body: expect.objectContaining({
        aggs: {
          categoryCount: { cardinality: { field: "signalType.keyword" } },
        },
      }),
    }));
  });

  it("keeps numeric terms fields unsuffixed in the final OpenSearch request", async () => {
    vi.mocked(client.search).mockResolvedValueOnce({
      body: {
        hits: { total: { value: 10 } },
        aggregations: { byYear: { buckets: [] } },
      },
    } as never);

    await executeAggregate("RssbFraudSignal", {
      aggregations: [{ name: "byYear", type: "terms", field: "year" }],
    }, null, null);

    expect(client.search).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        aggs: { byYear: { terms: { field: "year", size: 100 } } },
      }),
    }));
  });
});

describe("buildAggClause — terms + nested metric", () => {
  it("uses ontology-resolved exact fields for string cardinality and preserves numeric fields", () => {
    expect(buildAggClause(
      { name: "categoryCount", type: "cardinality", field: "signalType" },
      keywordField,
    )).toEqual({ cardinality: { field: "signalType.keyword" } });

    expect(buildAggClause(
      { name: "yearCount", type: "cardinality", field: "year" },
      (field) => field,
    )).toEqual({ cardinality: { field: "year" } });
  });

  it("count (or no metric) emits a bare terms bucket — doc_count is the value", () => {
    const noMetric = buildAggClause({ name: "byReason", type: "terms", field: "reason" }, keywordField);
    expect(noMetric).toEqual({ terms: { field: "reason.keyword", size: 100 } });

    const countMetric = buildAggClause({
      name: "byReason",
      type: "terms",
      field: "reason",
      metric: { type: "count" },
    }, keywordField);
    // `count` is a no-op: no nested aggregation.
    expect(countMetric).toEqual({ terms: { field: "reason.keyword", size: 100 } });
  });

  it("a secondary groupBy nests a `series` terms sub-aggregation (Chart XY multi-series)", () => {
    // count series: nested terms, no metric sub-agg.
    const countSeries = buildAggClause({
      name: "byXY",
      type: "terms",
      field: "year",
      groupBy: { field: "aircraft", size: 12 },
    }, keywordField);
    expect(countSeries).toEqual({
      terms: { field: "year.keyword", size: 100 },
      aggs: { series: { terms: { field: "aircraft.keyword", size: 12 } } },
    });

    // sum series: the metric sub-agg lives UNDER the series buckets.
    const sumSeries = buildAggClause({
      name: "byXY",
      type: "terms",
      field: "year",
      size: 20,
      groupBy: { field: "aircraft" },
      metric: { type: "sum", field: "delay" },
    }, keywordField);
    expect(sumSeries).toEqual({
      terms: { field: "year.keyword", size: 20 },
      aggs: {
        series: {
          terms: { field: "aircraft.keyword", size: 50 },
          aggs: { metric: { sum: { field: "delay" } } },
        },
      },
    });
  });

  it("sum/avg/min/max/cardinality attach a nested metric sub-aggregation over metric.field", () => {
    const resolveField = (field: string) => field === "reason" ? "reason.keyword" : field;
    const expectations: Array<[string, Record<string, unknown>]> = [
      ["sum", { sum: { field: "delay" } }],
      ["avg", { avg: { field: "delay" } }],
      ["min", { min: { field: "delay" } }],
      ["max", { max: { field: "delay" } }],
      ["cardinality", { cardinality: { field: "delay" } }],
    ];
    for (const [type, sub] of expectations) {
      const clause = buildAggClause({
        name: "byReason",
        type: "terms",
        field: "reason",
        size: 12,
        metric: { type, field: "delay" },
      }, resolveField);
      expect(clause).toEqual({
        terms: { field: "reason.keyword", size: 12 },
        aggs: { metric: sub },
      });
    }
  });

  it("uses the keyword sub-field for a nested cardinality metric on a string", () => {
    const clause = buildAggClause({
      name: "bySeverity",
      type: "terms",
      field: "severity",
      metric: { type: "cardinality", field: "signalType" },
    }, keywordField);

    expect(clause).toEqual({
      terms: { field: "severity.keyword", size: 100 },
      aggs: { metric: { cardinality: { field: "signalType.keyword" } } },
    });
  });
});

describe("formatAggregationResponse — terms buckets carry a per-slice value", () => {
  it("reads the nested metric value when present", () => {
    const osResponse = {
      hits: { total: { value: 130 } },
      aggregations: {
        byReason: {
          buckets: [
            { key: "Weather", doc_count: 62, metric: { value: 540 } },
            // A real zero metric value must survive the `?? 0` nullish guard.
            { key: "Mechanical", doc_count: 55, metric: { value: 0 } },
          ],
        },
      },
    };
    const out = formatAggregationResponse(osResponse, [{ name: "byReason", type: "terms" }]);
    const data = out.data as Record<string, unknown>;
    expect(data.totalCount).toBe(130);
    expect(data.byReason).toEqual([
      { key: "Weather", count: 62, value: 540 },
      { key: "Mechanical", count: 55, value: 0 },
    ]);
  });

  it("falls back to doc_count as the value when no metric sub-agg is present", () => {
    const osResponse = {
      hits: { total: { value: 9 } },
      aggregations: {
        byReason: {
          buckets: [
            { key: "Weather", doc_count: 6 },
            { key: "Other", doc_count: 3 },
          ],
        },
      },
    };
    const out = formatAggregationResponse(osResponse, [{ name: "byReason", type: "terms" }]);
    const data = out.data as Record<string, unknown>;
    expect(data.byReason).toEqual([
      { key: "Weather", count: 6, value: 6 },
      { key: "Other", count: 3, value: 3 },
    ]);
  });

  it("flattens nested `series` sub-buckets into a per-bucket series array (Chart XY)", () => {
    const osResponse = {
      hits: { total: { value: 100 } },
      aggregations: {
        byXY: {
          buckets: [
            {
              key: "2021",
              doc_count: 40,
              series: {
                buckets: [
                  { key: "A320", doc_count: 25, metric: { value: 130 } },
                  { key: "A321", doc_count: 15, metric: { value: 70 } },
                ],
              },
            },
            {
              key: "2022",
              doc_count: 60,
              series: { buckets: [{ key: "A320", doc_count: 60 }] }, // no metric → value == count
            },
          ],
        },
      },
    };
    const out = formatAggregationResponse(osResponse, [{ name: "byXY", type: "terms" }]);
    const data = out.data as Record<string, unknown>;
    expect(data.byXY).toEqual([
      {
        key: "2021",
        count: 40,
        value: 40,
        series: [
          { key: "A320", count: 25, value: 130 },
          { key: "A321", count: 15, value: 70 },
        ],
      },
      {
        key: "2022",
        count: 60,
        value: 60,
        series: [{ key: "A320", count: 60, value: 60 }],
      },
    ]);
  });
});
