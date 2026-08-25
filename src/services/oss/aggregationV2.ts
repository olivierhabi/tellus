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
export const DEFAULT_COMPOSITE_PAGE_SIZE = 1_000;

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

export interface CompositeAggregationBuild {
  aggs: Record<string, unknown>;
  metricNames: string[];
  sourceNames: string[];
  groupNames: string[];
}

/** Composite supports every unbounded grouping used by the public contract.
 * Range groupings are deliberately handled by the finite range aggregation
 * path because OpenSearch does not expose a composite range source. */
export function supportsCompositeGrouping(
  groupBy: AggregationGroupByV2[],
): boolean {
  return (
    groupBy.length > 0 &&
    groupBy.every((grouping) => grouping.type !== "ranges")
  );
}

/**
 * Build one page of an exact composite aggregation. Source names are private
 * and index-based so repeated property identifiers cannot collide.
 */
export function buildCompositeV2Aggs(
  aggregation: AggregationV2[],
  groupBy: AggregationGroupByV2[],
  keywordOf: (field: string) => string,
  after: Record<string, unknown> | undefined,
  pageSize = DEFAULT_COMPOSITE_PAGE_SIZE,
): CompositeAggregationBuild {
  if (!supportsCompositeGrouping(groupBy)) {
    throw new AggregationError(
      "AggregationAccuracyNotSupported",
      "The requested grouping cannot be paged with an exact composite aggregation.",
      { groupByTypes: groupBy.map((grouping) => grouping.type) },
    );
  }
  const metricNames: string[] = [];
  const metricAggs: Record<string, unknown> = {};
  for (let i = 0; i < aggregation.length; i++) {
    const metric = aggregation[i]!;
    const name =
      metric.name ??
      `${metric.type}_${(metric as { field?: string }).field ?? "objects"}_${i}`;
    metricNames.push(name);
    metricAggs[name] = metricAgg(metric, (field) => field ?? "__pk");
    if (metric.type === "avg") {
      metricAggs[`__merge_sum_${i}`] = {
        sum: { field: metric.field },
      };
      metricAggs[`__merge_count_${i}`] = {
        value_count: { field: metric.field },
      };
    }
  }
  const sourceNames: string[] = [];
  const groupNames: string[] = [];
  const sources = groupBy.map((grouping, index) => {
    const sourceName = `g${index}`;
    sourceNames.push(sourceName);
    groupNames.push(groupByLevelName(grouping));
    switch (grouping.type) {
      case "exact":
        return {
          [sourceName]: {
            terms: {
              field: keywordOf(grouping.field),
              ...(grouping.includeNullValues
                ? { missing_bucket: true, missing_order: "first" }
                : {}),
            },
          },
        };
      case "fixedWidth":
        return {
          [sourceName]: {
            histogram: {
              field: grouping.field,
              interval: grouping.fixedWidth,
            },
          },
        };
      case "duration":
        return {
          [sourceName]: {
            date_histogram: {
              field: grouping.field,
              ...durationInterval(grouping.value, grouping.unit),
            },
          },
        };
      case "objectType":
        return {
          [sourceName]: {
            terms: { field: "__objectType" },
          },
        };
      case "ranges":
        throw new AggregationError(
          "AggregationAccuracyNotSupported",
          "Range groupings use the finite exact aggregation path.",
        );
    }
  });
  return {
    aggs: {
      __composite: {
        composite: {
          size: pageSize,
          sources,
          ...(after ? { after } : {}),
        },
        aggs: metricAggs,
      },
    },
    metricNames,
    sourceNames,
    groupNames,
  };
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
  /** Exact cross-plan merge state for averages. */
  _averageState?: Record<string, { sum: number; count: number }>;
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
  after_key?: Record<string, unknown>;
  value?: unknown;
  values?: Record<string, unknown>;
}

export interface ParsedCompositePage {
  items: AggregationItemV2[];
  afterKey?: Record<string, unknown>;
}

/** Parse one composite page without losing the private merge state required
 * for mathematically correct cross-plan averages. */
export function parseCompositeV2Page(
  osAggs: Record<string, BucketNode>,
  aggregation: AggregationV2[],
  groupBy: AggregationGroupByV2[],
  metricNames: string[],
  sourceNames: string[],
  groupNames: string[],
): ParsedCompositePage {
  const composite = osAggs.__composite;
  if (!composite) return { items: [] };
  const items = (composite.buckets ?? []).map((bucket) => {
    const key = (bucket.key ?? {}) as Record<string, unknown>;
    const group: Record<string, unknown> = {};
    for (let i = 0; i < sourceNames.length; i++) {
      const grouping = groupBy[i]!;
      let value = key[sourceNames[i]!];
      if (
        grouping.type === "exact" &&
        value == null &&
        grouping.includeNullValues
      ) {
        value = grouping.defaultValue ?? null;
      } else if (
        grouping.type === "duration" &&
        (typeof value === "number" ||
          (typeof value === "string" && /^\d+$/.test(value)))
      ) {
        value = new Date(Number(value)).toISOString();
      }
      group[groupNames[i]!] = value;
    }
    const averageState: Record<string, { sum: number; count: number }> = {};
    const metrics = metricNames.map((name, index) => {
      if (aggregation[index]?.type === "avg") {
        const sum = Number(
          extractMetric(
            bucket[`__merge_sum_${index}`] as BucketNode | undefined,
          ) ?? 0,
        );
        const count = Number(
          extractMetric(
            bucket[`__merge_count_${index}`] as BucketNode | undefined,
          ) ?? 0,
        );
        averageState[name] = { sum, count };
      }
      return {
        name,
        value: extractMetric(bucket[name] as BucketNode | undefined),
      };
    });
    return {
      group,
      metrics,
      _docCount: Number(bucket.doc_count ?? 0),
      ...(Object.keys(averageState).length > 0
        ? { _averageState: averageState }
        : {}),
    };
  });
  return {
    items,
    ...(composite.after_key ? { afterKey: composite.after_key } : {}),
  };
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
