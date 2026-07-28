// ---------------------------------------------------------------------------
// AggregationV2 — verified contract
// (@osdk/foundry.ontologies@2.69.0)
//
//   aggregations: count | sum | avg | min | max |
//                 approximateDistinct | exactDistinct |
//                 approximatePercentile
//   groupBy:      exact | fixedWidth | ranges | duration | objectType
//   accuracy:     REQUIRE_ACCURATE | ALLOW_APPROXIMATE
//   response:     { excludedItems?, accuracy, data: [{ group, metrics }] }
//
// Accuracy is REAL, not faked with a bigger terms size: when a bucket
// level reports sum_other_doc_count > 0 and the caller demanded
// REQUIRE_ACCURATE, we throw AggregationAccuracyNotSupported —
// the verified error — instead of silently returning approximate data.
// ---------------------------------------------------------------------------

import type {
  AggregationV2,
  AggregationGroupByV2,
  AggregationAccuracyRequest,
} from "./objectSetDefinition";

export class AggregationError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AggregationError";
  }
}

// ---------------------------------------------------------------------------
// OS agg building
// ---------------------------------------------------------------------------

const EXACT_DISTINCT_PRECISION = 40_000;
const DEFAULT_MAX_GROUP_COUNT = 10_000;

/** TimeUnit → date_histogram interval (verified: value must be 1 for
 *  WEEKS/MONTHS/QUARTERS/YEARS). */
function durationInterval(
  value: number,
  unit: string,
): { fixed_interval?: string; calendar_interval?: string } {
  switch (unit) {
    case "SECONDS": return { fixed_interval: `${value}s` };
    case "MINUTES": return { fixed_interval: `${value}m` };
    case "HOURS": return { fixed_interval: `${value}h` };
    case "DAYS": return { fixed_interval: `${value}d` };
    case "WEEKS":
      assertUnitValueOne(value, unit);
      return { calendar_interval: "week" };
    case "MONTHS":
      assertUnitValueOne(value, unit);
      return { calendar_interval: "month" };
    case "QUARTERS":
      assertUnitValueOne(value, unit);
      return { calendar_interval: "quarter" };
    case "YEARS":
      assertUnitValueOne(value, unit);
      return { calendar_interval: "year" };
    default:
      throw new AggregationError("InvalidTimeUnit", `Unknown TimeUnit: ${unit}`);
  }
}

function assertUnitValueOne(value: number, unit: string): void {
  if (value !== 1) {
    throw new AggregationError(
      "InvalidAggregationDurationValue",
      `When grouping by ${unit}, the value must be set to 1.`,
      { unit, value },
    );
  }
}

export interface AggFieldResolver {
  /** property apiName → { keyword field, base field } */
  resolve: (
    field: string,
  ) => Promise<{ keyword: string; field: string }>;
}

function metricAgg(a: AggregationV2, fieldOf: (f?: string) => string): Record<string, unknown> {
  switch (a.type) {
    case "count":
      return { value_count: { field: "__pk" } };
    case "sum":
      return { sum: { field: fieldOf(a.field) } };
    case "avg":
      return { avg: { field: fieldOf(a.field) } };
    case "min":
      return { min: { field: fieldOf(a.field) } };
    case "max":
      return { max: { field: fieldOf(a.field) } };
    case "approximateDistinct":
      return { cardinality: { field: fieldOf(a.field) } };
    case "exactDistinct":
      return {
        cardinality: {
          field: fieldOf(a.field),
          precision_threshold: EXACT_DISTINCT_PRECISION,
        },
      };
    case "approximatePercentile":
      return {
        percentiles: {
          field: fieldOf(a.field),
          percents: [a.approximatePercentile],
        },
      };
  }
}

export function groupByLevelName(g: AggregationGroupByV2): string {
  return g.type === "objectType" ? "__objectType" : (g as { field: string }).field;
}

/**
 * Build the nested OS `aggs` block for a v2 aggregate request.
 * `fieldOf` maps a property apiName to its OS keyword field for
 * bucketing (exact/objectType) and its base field for metrics.
 */
export function buildV2Aggs(
  aggregation: AggregationV2[],
  groupBy: AggregationGroupByV2[],
  keywordOf: (field: string) => string,
): { aggs: Record<string, unknown>; metricNames: string[] } {
  const metricNames: string[] = [];
  const metricAggs: Record<string, unknown> = {};
  for (let i = 0; i < aggregation.length; i++) {
    const a = aggregation[i]!;
    const name = a.name ?? `${a.type}_${(a as { field?: string }).field ?? "objects"}_${i}`;
    metricNames.push(name);
    metricAggs[name] = metricAgg(a, (f) => f ?? "__pk");
  }

  if (groupBy.length === 0) {
    // Ungrouped: one synthetic bucket carrying the metrics.
    return { aggs: { __all: { global: {}, aggs: metricAggs } }, metricNames };
  }

  // Nest groupBy levels; metrics (+ _dc doc count for weighted
  // cross-plan merging) hang off the innermost level.
  const build = (level: number): Record<string, unknown> => {
    const g = groupBy[level]!;
    const inner =
      level === groupBy.length - 1
        ? { ...metricAggs, _dc: { value_count: { field: "__pk" } } }
        : { ...build(level + 1), _dc: { value_count: { field: "__pk" } } };
    const name = groupByLevelName(g);
    switch (g.type) {
      case "exact": {
        const terms: Record<string, unknown> = {
          field: keywordOf(g.field),
          size: g.maxGroupCount ?? DEFAULT_MAX_GROUP_COUNT,
        };
        if (g.includeNullValues) terms.missing = g.defaultValue ?? null;
        return { [name]: { terms, aggs: inner } };
      }
      case "fixedWidth":
        return {
          [name]: {
            histogram: { field: g.field, interval: g.fixedWidth },
            aggs: inner,
          },
        };
      case "ranges":
        return {
          [name]: {
            range: {
              field: g.field,
              ranges: g.ranges.map((r) => ({
                from: r.startValue,
                to: r.endValue,
              })),
            },
            aggs: inner,
          },
        };
      case "duration":
        return {
          [name]: {
            date_histogram: { field: g.field, ...durationInterval(g.value, g.unit) },
            aggs: inner,
          },
        };
      case "objectType":
        return {
          [name]: {
            terms: { field: "__objectType", size: DEFAULT_MAX_GROUP_COUNT },
            aggs: inner,
          },
        };
    }
  };
  return { aggs: build(0), metricNames };
}

// ---------------------------------------------------------------------------
// Response shaping + accuracy
// ---------------------------------------------------------------------------

export interface AggregationItemV2 {
  group: Record<string, unknown>;
  metrics: Array<{ name: string; value: unknown }>;
  /** Leaf bucket doc count — internal, used for weighted
   *  cross-plan avg merging. Never serialized to clients. */
  _docCount?: number;
}

export interface ParsedAggregation {
  items: AggregationItemV2[];
  excludedItems: number;
  /** True when any terms level truncated (sum_other_doc_count > 0). */
  approximate: boolean;
}

interface BucketNode {
  buckets?: Array<Record<string, unknown>>;
  sum_other_doc_count?: number;
  value?: unknown;
  values?: Record<string, unknown>;
}

/** Walk the nested OS response into flat v2 items. */
export function parseV2AggResponse(
  osAggs: Record<string, BucketNode>,
  groupBy: AggregationGroupByV2[],
  metricNames: string[],
): ParsedAggregation {
  const items: AggregationItemV2[] = [];
  let excluded = 0;
  let approximate = false;

  if (groupBy.length === 0) {
    const globalAgg = osAggs.__all as Record<string, unknown> | undefined;
    const metrics = metricNames.map((name) => ({
      name,
      value: extractMetric((globalAgg ?? {})[name] as BucketNode | undefined),
    }));
    items.push({ group: {}, metrics });
    return { items, excludedItems: 0, approximate: false };
  }

  const walk = (
    level: number,
    node: Record<string, unknown>,
    groupAcc: Record<string, unknown>,
  ): void => {
    const name = groupByLevelName(groupBy[level]!);
    const agg = node[name] as BucketNode | undefined;
    if (!agg) return;
    if ((agg.sum_other_doc_count ?? 0) > 0) {
      approximate = true;
      if (level === 0) excluded += agg.sum_other_doc_count!;
    }
    for (const bucket of agg.buckets ?? []) {
      const key = (bucket.key_as_string ?? bucket.key) as unknown;
      const group = { ...groupAcc, [name]: key };
      if (level === groupBy.length - 1) {
        const metrics = metricNames.map((m) => ({
          name: m,
          value: extractMetric(bucket[m] as BucketNode | undefined),
        }));
        items.push({
          group,
          metrics,
          _docCount: (bucket.doc_count as number | undefined) ?? 0,
        });
      } else {
        walk(level + 1, bucket, group);
      }
    }
  };
  walk(0, osAggs as Record<string, unknown>, {});

  // Deterministic bucket ordering: group keys lexicographic by level order.
  items.sort((a, b) => {
    for (const g of groupBy) {
      const k = groupByLevelName(g);
      const av = String(a.group[k]);
      const bv = String(b.group[k]);
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  });

  return { items, excludedItems: excluded, approximate };
}

function extractMetric(node: BucketNode | undefined): unknown {
  if (!node) return null;
  if (node.values) {
    // percentiles → single requested percentile value
    const vals = Object.values(node.values);
    return vals.length === 1 ? vals[0] : node.values;
  }
  return node.value ?? null;
}

/**
 * Accuracy gate (verified semantics): REQUIRE_ACCURATE + truncation →
 * typed error; otherwise echo ACCURATE/APPROXIMATE in the response.
 */
export function assertAccuracy(
  parsed: ParsedAggregation,
  request: AggregationAccuracyRequest | undefined,
): "ACCURATE" | "APPROXIMATE" {
  if (parsed.approximate) {
    if (request === "REQUIRE_ACCURATE") {
      throw new AggregationError(
        "AggregationAccuracyNotSupported",
        "Accurate aggregation cannot be guaranteed: the result set has " +
          "more distinct group values than the allowed group count.",
        { excludedItems: parsed.excludedItems },
      );
    }
    return "APPROXIMATE";
  }
  return "ACCURATE";
}
