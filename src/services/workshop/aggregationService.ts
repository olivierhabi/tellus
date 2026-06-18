// =============================================================================
// B08 — Workshop Aggregation Proxy
//
// Spec §B08:
//   group-by kinds: exact, fixedWidthBuckets, dateRangeBuckets, topN
//   aggregation kinds: count, sum, avg, min, max, approxDistinct
//   Bar XY for numeric x-axis defaults to fixedWidthBuckets, NOT exact —
//   spec explicitly calls out: "no spec-compiler path produces one bar per
//   distinct value when the property is numeric." Avoiding the visual squash
//   in Phase 5 Step 6.
//
// This service:
//   1. Validates aggregation defs vs schema
//   2. Applies the Bar-XY-numeric default-to-fixedWidthBuckets rule
//   3. Compiles filters → predicate tree (B07)
//   4. Forwards to OSS adapter
// =============================================================================

import { getOss, type OssAggregateRequest, type OssAggregateResponse, type OssAggregationDef, type OssRequestContext } from "./ossAdapter.js";
import { compileFilters, type FilterValueIn, type PropertyType } from "./filterCompiler.js";
import { workshopError } from "./errors.js";
import {
  histAggregate,
  counterAggregate,
  counterGroupByKind,
} from "./metrics.js";
import { withTimeout, withCircuit, getOssTimeoutMs } from "./timeouts.js";

export type ChartKind = "pie" | "barXy" | "stackedBar" | "metric";

export interface AggregateRequestIn {
  ontologyRid: string;
  objectTypeApiName: string;
  schema: Readonly<Record<string, PropertyType>>;
  filters: ReadonlyArray<FilterValueIn>;
  aggregations: ReadonlyArray<OssAggregationDef>;
  /** When provided, the compiler enforces the chart-kind defaults (Bar XY rule). */
  chartKind?: ChartKind;
  executionMode?: "PREFER_ACCURACY" | "PREFER_SPEED" | null;
}

const NUMERIC_TYPES: ReadonlyArray<PropertyType> = ["integer", "long", "double"];

function isNumeric(t: PropertyType | undefined): boolean {
  return !!t && NUMERIC_TYPES.includes(t);
}

/**
 * Default-fills group-by per chart kind. The Bar-XY numeric default-rule lives
 * here so neither the route nor the OSS layer can bypass it.
 *
 * Spec §B08 + §F07 + §C Phase 5 Step 6: when chartKind === "barXy" and the
 * group-by property is numeric AND no explicit groupBy is provided, default
 * to fixedWidthBuckets. The bucket width is computed by the OSS layer; we
 * pass `width: 0` as a sentinel meaning "auto", and OSS picks based on the
 * value range. width=0 is what the spec calls out as the default sentinel.
 */
export function applyChartKindDefaults(
  agg: OssAggregationDef,
  schema: Readonly<Record<string, PropertyType>>,
  chartKind: ChartKind | undefined,
): OssAggregationDef {
  if (!chartKind) return agg;
  if (agg.groupBy) return agg; // explicit groupBy wins

  const propType = schema[agg.property];

  if (chartKind === "barXy" && isNumeric(propType)) {
    return {
      ...agg,
      // sentinel width 0 = auto-bucket; min-buckets default 10 per spec
      groupBy: { kind: "fixedWidthBuckets", width: 0, minBuckets: 10 },
    };
  }
  // pie / stackedBar / metric over a string-typed property → exact
  if ((chartKind === "pie" || chartKind === "stackedBar") && propType === "string") {
    return { ...agg, groupBy: { kind: "exact" } };
  }
  return agg;
}

function validateAggregation(
  agg: OssAggregationDef,
  schema: Readonly<Record<string, PropertyType>>,
): void {
  if (!schema[agg.property]) {
    throw workshopError({
      errorName: "Tellus:Workshop:UnknownAggregationProperty",
      status: 400,
      parameters: { property: agg.property },
    });
  }
  // Aggregation `on` field must exist when present
  if ("on" in agg.aggregation) {
    const onProp = (agg.aggregation as { on: string }).on;
    if (!schema[onProp]) {
      throw workshopError({
        errorName: "Tellus:Workshop:UnknownAggregationProperty",
        status: 400,
        parameters: { property: onProp },
      });
    }
    // sum/avg/min/max require numeric
    if (
      (agg.aggregation.kind === "sum" ||
        agg.aggregation.kind === "avg" ||
        agg.aggregation.kind === "min" ||
        agg.aggregation.kind === "max") &&
      !isNumeric(schema[onProp])
    ) {
      throw workshopError({
        errorName: "Tellus:Workshop:UnsupportedAggregationPropertyType",
        status: 400,
        parameters: {
          aggregation: agg.aggregation.kind,
          property: onProp,
          propertyType: schema[onProp],
        },
      });
    }
  }
  if (agg.groupBy?.kind === "fixedWidthBuckets" && !isNumeric(schema[agg.property])) {
    throw workshopError({
      errorName: "Tellus:Workshop:UnsupportedGroupByPropertyType",
      status: 400,
      parameters: { groupBy: "fixedWidthBuckets", property: agg.property },
    });
  }
}

export async function aggregate(
  req: AggregateRequestIn,
  ctx: OssRequestContext,
): Promise<OssAggregateResponse> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    return await _aggregateInner(req, ctx);
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histAggregate.observe({ result }, ns / 1e9);
    counterAggregate.inc({ status: result }, 1);
  }
}

async function _aggregateInner(
  req: AggregateRequestIn,
  ctx: OssRequestContext,
): Promise<OssAggregateResponse> {
  if (req.aggregations.length === 0) {
    throw workshopError({
      errorName: "Tellus:Workshop:NoAggregationSpecified",
      status: 400,
    });
  }

  const compiled = req.aggregations.map((a) =>
    applyChartKindDefaults(a, req.schema, req.chartKind),
  );
  for (const a of compiled) {
    validateAggregation(a, req.schema);
    // Per-keystroke instrumentation of group-by selection — used to detect
    // any regression of the Bar-XY-numeric default-bucketing rule.
    const propType = req.schema[a.property] ?? "unknown";
    counterGroupByKind.inc(
      { kind: a.groupBy?.kind ?? "none", property_type: propType },
      1,
    );
  }

  const predicate = compileFilters(req.filters, { properties: req.schema });

  const ossReq: OssAggregateRequest = {
    ontologyRid: req.ontologyRid,
    objectTypeApiName: req.objectTypeApiName,
    predicate,
    aggregations: compiled,
    executionMode: req.executionMode ?? null,
  };

  return await withCircuit("oss", () =>
    withTimeout(getOss().aggregate(ossReq, ctx), getOssTimeoutMs(), "oss"),
  );
}
