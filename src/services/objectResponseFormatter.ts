// ---------------------------------------------------------------------------
// Object Response Formatter
//
// Transforms OpenSearch responses into the clean Palantir-style API format.
// Hides OpenSearch internals (_index, _id, _score, _source, _sort).
//
// Task 7 — distinct from src/utils/responseFormatter.ts (metadata CRUD).
// ---------------------------------------------------------------------------

import { createPageToken } from "./paginationService";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormattedListResponse {
  data: Array<Record<string, unknown>>;
  nextPageToken: string | null;
  totalCount: number;
}

/**
 * Phase 2 (OSSv2 parity) — formatting options.
 * `excludeRid` mirrors the public v2 `excludeRid` request flag:
 * when true, `__rid` is stripped from formatted objects.
 */
export interface FormatOptions {
  excludeRid?: boolean;
}

// ---------------------------------------------------------------------------
// formatObjectList
// ---------------------------------------------------------------------------

/**
 * Transform OpenSearch search response into the API list format.
 */
export function formatObjectList(
  opensearchResponse: any,
  objectTypeApiName: string,
  allPropertyApiNames: string[],
  selectProperties: string[] | undefined,
  orderBy: Array<{ field: string; direction: string }>,
  whereClause: unknown,
  pageSize: number,
  options?: FormatOptions
): FormattedListResponse {
  const hitsObj = opensearchResponse?.hits;
  if (!hitsObj || !hitsObj.hits) {
    return { data: [], nextPageToken: null, totalCount: 0 };
  }

  const rawHits: any[] = hitsObj.hits;
  const totalValue =
    typeof hitsObj.total === "object" ? hitsObj.total.value : hitsObj.total ?? 0;

  // We request pageSize + 1 to detect next page
  const hasMore = rawHits.length > pageSize;
  const hitsToReturn = hasMore ? rawHits.slice(0, pageSize) : rawHits;

  const data: Array<Record<string, unknown>> = [];

  for (const hit of hitsToReturn) {
    const source = hit._source || {};
    const formatted = formatSingleSource(source, objectTypeApiName, allPropertyApiNames, selectProperties, options);

    // Include highlights if present
    if (hit.highlight) {
      formatted.__highlights = hit.highlight;
    }

    data.push(formatted);
  }

  // Build the next page token from the last hit's sort values.
  //
  // PITFALL: OpenSearch/Elasticsearch 7.5+ ONLY populates `hit._sort` for
  // non-fielddata sort criteria. A sort clause consisting solely of `keyword`
  // doc-value fields (e.g. the injected `__pk` tiebreaker) hits an
  // optimization that omits `_sort` from every hit — which previously made
  // `nextPageToken` permanently null on unfiltered (pk-only) sorts and broke
  // cursor pagination end-to-end.
  //
  // Fallback: derive the cursor from `hit._source` using the EFFECTIVE sort
  // fields (`orderBy` + `__pk` tiebreaker), preferring the property's
  // `dataType: keyword` sub-field when a `text` parent is sorted. This is
  // identical to what `search_after` needs — the raw doc-value — and keeps
  // the token contract (`createPageToken` shape) unchanged.
  let nextPageToken: string | null = null;
  if (hasMore && hitsToReturn.length > 0) {
    const lastHit = hitsToReturn[hitsToReturn.length - 1];
    const sortValues = resolveHitSortValues(lastHit, orderBy);
    if (sortValues) {
      nextPageToken = createPageToken(sortValues, orderBy, objectTypeApiName, whereClause);
    }
  }

  return { data, nextPageToken, totalCount: totalValue };
}

// ---------------------------------------------------------------------------
// Cursor fallback — doc-value recovery from `hit._source`
// ---------------------------------------------------------------------------

/** Lower-case keys for case-insensitive `__*` system-field lookups. */
function sourceValue(
  source: Record<string, unknown>,
  field: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(source, field)) return source[field];
  const lower = field.toLowerCase();
  for (const key of Object.keys(source)) {
    if (key.toLowerCase() === lower) return source[key];
  }
  return undefined;
}

/**
 * The effective ordered sort fields mirroring `buildSortClause`
 * (`orderBy` + `__pk` asc tiebreaker when absent). These MUST match the
 * OpenSearch sort clause 1:1 — the cursor payload is positional.
 */
function effectiveSortFields(
  orderBy: Array<{ field: string; direction: string }>,
): string[] {
  const fields = orderBy.map((o) => o.field);
  if (!fields.some((f) => f === "__pk" || f === "__primaryKey")) {
    fields.push("__pk");
  }
  return fields;
}

/**
 * Recover the doc-value sort criteria for `hit` — preferring `hit._sort`
 * (cheap, server-computed) and falling back to `hit._source` when the
 * `_sort` optimization omitted it (keyword-only sort clauses).
 * Returns null only when NEITHER source can satisfy the criteria — a
 * genuinely unsortable page, in which case a null token (page considered
 * last) is the safe degradation.
 */
export function resolveHitSortValues(
  hit: { _sort?: unknown; _source?: Record<string, unknown> },
  orderBy: Array<{ field: string; direction: string }>,
): unknown[] | null {
  const fields = effectiveSortFields(orderBy);
  if (Array.isArray(hit._sort) && hit._sort.length === fields.length) {
    return hit._sort as unknown[];
  }
  const source = hit._source ?? {};
  const values: unknown[] = [];
  for (const field of fields) {
    const v = sourceValue(source, field);
    if (v === undefined) return null;
    values.push(v);
  }
  return values;
}

// ---------------------------------------------------------------------------
// formatSingleObject
// ---------------------------------------------------------------------------

/**
 * Transform a single OpenSearch document into the API format.
 */
export function formatSingleObject(
  opensearchResponse: any,
  objectTypeApiName: string,
  options?: FormatOptions
): Record<string, unknown> | null {
  const source = opensearchResponse?._source;
  if (!source) return null;
  return formatSingleSource(source, objectTypeApiName, [], undefined, options);
}

// ---------------------------------------------------------------------------
// formatAggregationResponse
// ---------------------------------------------------------------------------

export function formatAggregationResponse(
  opensearchResponse: any,
  aggregationDefinitions: Array<{ name: string; type: string }>
): Record<string, unknown> {
  const aggs = opensearchResponse?.aggregations || {};
  const totalHits =
    typeof opensearchResponse?.hits?.total === "object"
      ? opensearchResponse.hits.total.value
      : opensearchResponse?.hits?.total ?? 0;

  const result: Record<string, unknown> = { totalCount: totalHits };

  for (const def of aggregationDefinitions) {
    const aggResult = aggs[def.name];
    if (!aggResult) {
      result[def.name] = null;
      continue;
    }

    switch (def.type) {
      case "count":
      case "cardinality":
        result[def.name] = aggResult.value ?? 0;
        break;

      case "avg":
      case "sum":
      case "min":
      case "max":
        result[def.name] = aggResult.value ?? null;
        break;

      case "terms":
        result[def.name] = (aggResult.buckets || []).map((b: any) => {
          const bucket: Record<string, unknown> = {
            key: b.key,
            count: b.doc_count,
            // `value` is what charts plot: the nested metric's result when a
            // metric sub-aggregation is present (sum/avg/min/max/approx-unique
            // per slice), otherwise the bucket's document count. Always set so
            // consumers never have to branch on metric presence.
            value:
              b.metric && typeof b.metric === "object"
                ? (b.metric.value ?? 0)
                : b.doc_count,
          };
          // Secondary group-by ("segment by"/series) sub-buckets, when the
          // request asked for a nested `groupBy` — the Chart XY multi-series
          // matrix. Each series sub-bucket carries its own count + value.
          if (b.series && Array.isArray(b.series.buckets)) {
            bucket.series = b.series.buckets.map((sb: any) => ({
              key: sb.key,
              count: sb.doc_count,
              value:
                sb.metric && typeof sb.metric === "object"
                  ? (sb.metric.value ?? 0)
                  : sb.doc_count,
            }));
          }
          return bucket;
        });
        break;

      case "date_histogram":
        result[def.name] = (aggResult.buckets || []).map((b: any) => ({
          key: b.key_as_string || b.key,
          count: b.doc_count,
        }));
        break;

      case "range":
        result[def.name] = (aggResult.buckets || []).map((b: any) => ({
          key: b.key,
          from: b.from,
          to: b.to,
          count: b.doc_count,
        }));
        break;

      default:
        result[def.name] = aggResult;
    }
  }

  return { data: result };
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function formatSingleSource(
  source: Record<string, unknown>,
  objectTypeApiName: string,
  allPropertyApiNames: string[],
  selectProperties: string[] | undefined,
  options?: FormatOptions
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  // Always include system identity fields. `__apiName` is the v2 name
  // for the object type's API name; `__objectType` is retained for v1
  // backward compatibility (Phase 2 — additive, not a rename).
  output.__primaryKey = source.__pk ?? null;
  output.__objectType = source.__objectType ?? objectTypeApiName;
  output.__apiName = source.__objectType ?? objectTypeApiName;
  // `__rid` is emitted when the document carries one (migration 138 +
  // indexer/editApplicator stamping). `excludeRid: true` strips it,
  // mirroring the public v2 request flag.
  if (source.__rid != null && options?.excludeRid !== true) {
    output.__rid = source.__rid;
  }

  if (selectProperties && selectProperties.length > 0) {
    // Only include selected properties + system fields
    for (const prop of selectProperties) {
      if (prop === "__pk" || prop === "__primaryKey") {
        // Already included
      } else if (prop === "__objectType") {
        // Already included
      } else if (prop === "__lastModified") {
        output.__lastModified = source.__lastModified ?? null;
      } else if (prop === "__version") {
        output.__version = source.__version ?? null;
      } else {
        output[prop] = source[prop] ?? null;
      }
    }
  } else {
    // Include all non-system fields from source
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("__")) continue; // skip system fields
      output[key] = value ?? null;
    }
    // Fill nulls for properties that exist in schema but missing from doc
    for (const prop of allPropertyApiNames) {
      if (prop.startsWith("__")) continue;
      if (!(prop in output)) {
        output[prop] = null;
      }
    }
  }

  // Always include __version for optimistic concurrency control (Task 22).
  // Palantir objects always expose their version so clients can use OCC.
  if (!("__version" in output)) {
    output.__version = source.__version ?? 0;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS  ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}`); }
  }

  console.log("=== ObjectResponseFormatter self-test ===");

  // Test formatSingleObject
  const single = formatSingleObject(
    { _source: { __pk: "EMP-001", __objectType: "Employee", __version: 3, fullName: "Test", salary: 100 } },
    "Employee"
  );
  assert(single !== null, "Single object not null");
  assert(single!.__primaryKey === "EMP-001", "Primary key extracted");
  assert(single!.__objectType === "Employee", "Object type set");
  assert(single!.fullName === "Test", "User field preserved");
  assert(!("__pk" in single!), "__pk removed from output");
  assert("__version" in single!, "__version included in output (Task 22: OCC)");
  assert(single!.__version === 3, "__version value preserved");

  // Test formatObjectList — empty
  const empty = formatObjectList(
    { hits: { hits: [], total: { value: 0 } } },
    "Employee", [], undefined, [], undefined, 100
  );
  assert(empty.data.length === 0, "Empty list has no data");
  assert(empty.nextPageToken === null, "Empty list has no pageToken");
  assert(empty.totalCount === 0, "Empty list totalCount = 0");

  // Test formatObjectList — with data and pagination
  const hits = [];
  for (let i = 0; i < 3; i++) {
    hits.push({
      _source: { __pk: `E-${i}`, __objectType: "Employee", name: `Name ${i}` },
      _sort: [i, `E-${i}`],
    });
  }
  const list = formatObjectList(
    { hits: { hits, total: { value: 10 } } },
    "Employee", ["name"], undefined, [{ field: "name", direction: "asc" }], null, 2
  );
  assert(list.data.length === 2, "Page size respected (2 of 3)");
  assert(list.nextPageToken !== null, "Next page token present");
  assert(list.totalCount === 10, "Total count preserved");
  assert(list.data[0].__primaryKey === "E-0", "First item correct");

  // Test $select
  const selectList = formatObjectList(
    {
      hits: {
        hits: [{ _source: { __pk: "X", __objectType: "T", a: 1, b: 2, c: 3 }, _sort: ["X"] }],
        total: { value: 1 },
      },
    },
    "T", ["a", "b", "c"], ["a"], [], null, 100
  );
  assert("a" in selectList.data[0], "$select includes 'a'");
  assert(!("b" in selectList.data[0]), "$select excludes 'b'");
  assert(!("c" in selectList.data[0]), "$select excludes 'c'");

  // Test formatAggregationResponse
  const agg = formatAggregationResponse(
    {
      hits: { total: { value: 100 } },
      aggregations: {
        avgSalary: { value: 125000 },
        byDept: { buckets: [{ key: "Eng", doc_count: 50 }, { key: "Sales", doc_count: 30 }] },
      },
    },
    [
      { name: "avgSalary", type: "avg" },
      { name: "byDept", type: "terms" },
    ]
  );
  assert((agg.data as any).totalCount === 100, "Agg totalCount");
  assert((agg.data as any).avgSalary === 125000, "Agg avg value");
  assert(Array.isArray((agg.data as any).byDept), "Agg terms is array");
  assert((agg.data as any).byDept[0].key === "Eng", "Agg terms first bucket key");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
