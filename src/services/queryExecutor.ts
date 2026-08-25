// ---------------------------------------------------------------------------
// OpenSearch Query Executor
//
// Orchestrates query execution: translates filters, builds sort/pagination,
// executes against OpenSearch, and formats the response.
//
// Task 8: Core query execution engine
// ---------------------------------------------------------------------------

import { client, injectSecurityFilter } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { translateFilter, buildSortClause } from "./queryTranslator";
import { resolveAllProperties } from "./propertyResolver";
import { MAX_TERMS_BUCKET_SIZE } from "../utils/constants";
import {
  createPageToken,
  decodePageToken,
  buildSearchAfterClause,
} from "./paginationService";
import {
  formatObjectList,
  formatSingleObject,
  formatAggregationResponse,
  type FormattedListResponse,
} from "./objectResponseFormatter";
import { appError } from "../utils/appError";
import { incCounter } from "./funnel/metrics";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchParams {
  where?: any;
  $orderBy?: Array<{ field: string; direction: string }>;
  $pageSize?: number;
  $pageToken?: string;
  $select?: string[];
}

export interface AggregateParams {
  where?: any;
  aggregations: Array<{
    name: string;
    type: string;
    field?: string;
    size?: number;
    interval?: string;
    ranges?: Array<{ key?: string; from?: unknown; to?: unknown }>;
    /**
     * Optional nested metric for a bucketing aggregation (`terms` today).
     * When present, each bucket carries a sub-aggregated VALUE in addition
     * to its document `count` — this is what lets the Pie Chart widget plot
     * "sum/avg/min/max/approximate-unique-count of <metric.field> per
     * <group-by> slice" rather than only a per-slice document count.
     * `type: "count"` is a no-op (the bucket's doc_count already IS the
     * count) and emits no sub-aggregation.
     */
    metric?: { type: string; field?: string };
    /**
     * Optional SECONDARY group-by ("segment by"/series) nested under a
     * `terms` aggregation. When present each top-level bucket carries a
     * `series` array — one sub-bucket per distinct value of `groupBy.field`,
     * each with its own `count` and (if a `metric` is set) `value`. This is
     * what lets the Chart XY widget plot multiple series (grouped/stacked
     * bars, multi-line/area) from ONE request: the full X × series × Y
     * matrix comes back in a single round-trip.
     */
    groupBy?: { field: string; size?: number };
  }>;
}

// ---------------------------------------------------------------------------
// executeSearch
// ---------------------------------------------------------------------------

export async function executeSearch(
  objectTypeApiName: string,
  params: SearchParams,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<FormattedListResponse> {
  const indexName = getIndexName(objectTypeApiName);
  const pageSize = params.$pageSize ?? 100;
  const orderBy = params.$orderBy || [];

  // Translate filter
  const osQuery = await translateFilter(params.where, objectTypeApiName);

  // Build sort
  const sortClause = await buildSortClause(orderBy, objectTypeApiName);

  // Build search body
  const body: Record<string, unknown> = {
    size: pageSize + 1, // extra one to detect next page
    query: osQuery,
    sort: sortClause,
    track_total_hits: true,
  };

  // Handle page token (search_after)
  if (params.$pageToken) {
    const decoded = decodePageToken(params.$pageToken, objectTypeApiName, params.where);
    body.search_after = buildSearchAfterClause(decoded);
  }

  // Handle $select (_source filtering)
  if (params.$select && params.$select.length > 0) {
    // Always include system fields needed for formatting
    const sourceFields = [...new Set([
      ...params.$select,
      "__pk",
      "__objectType",
    ])];
    body._source = sourceFields;
  }

  // Inject mandatory security filter (§Task 28) + F-P3-13 branch filter
  const finalBody = injectSecurityFilter(body, securityFilter, branchId);

  // Execute
  let response: any;
  try {
    const result = await client.search({ index: indexName, body: finalBody });
    response = result.body;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return { data: [], nextPageToken: null, totalCount: 0 };
    }
    throw appError("OPENSEARCH_ERROR", `OpenSearch query failed: ${err.message}`);
  }

  // Get all property names for null-filling
  const allProps = await resolveAllProperties(objectTypeApiName);
  const allPropNames = [...allProps.keys()].filter((k) => !k.startsWith("__"));

  return formatObjectList(
    response,
    objectTypeApiName,
    allPropNames,
    params.$select,
    orderBy,
    params.where,
    pageSize
  );
}

// ---------------------------------------------------------------------------
// executeGetObject
// ---------------------------------------------------------------------------

export async function executeGetObject(
  objectTypeApiName: string,
  primaryKey: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Record<string, unknown> | null> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await client.get({ index: indexName, id: primaryKey });

    // Post-fetch security check (§Task 28 + F-03 remediation): client.get()
    // bypasses query-level filters, so we re-issue the fetch as a filtered
    // search to honor the security context. The check runs UNCONDITIONALLY
    // when a filter is active — the pre-remediation `if (source?._security)`
    // gate leaked existence of documents that predated the marking model,
    // because a missing `_security` field skipped the check entirely.
    //
    // A document without `_security.markings` now fails the filter (because
    // `buildSecurityFilter` no longer emits a `must_not.exists` branch),
    // so this path returns null — the document becomes invisible, not
    // leaked. System principals bypass this via a null filter from
    // `buildSecurityFilter`, matching Foundry's service-token contract.
    // F-P3-13: run the post-fetch check when either a security filter
    // is active OR a branch filter is active. `branchId === null` with
    // no security filter means "cross-branch and unsecured" — rare,
    // documented by the caller; in that case we skip the check.
    if (securityFilter || branchId !== null) {
      try {
        const checkBody = injectSecurityFilter(
          { query: { ids: { values: [primaryKey] } }, size: 0, track_total_hits: true },
          securityFilter,
          branchId,
        );
        const { body: checkResp } = await client.search({ index: indexName, body: checkBody });
        const total = (checkResp as any).hits?.total;
        const count = typeof total === "object" ? total.value : total;
        if (count === 0) return null;
      } catch {
        // Security verification failed — deny access to prevent leaks.
        // This includes OS failures and transient network errors: we
        // prefer a spurious 404 over an unauthorized leak.
        return null;
      }
    }

    return formatSingleObject(body, objectTypeApiName);
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return null;
    }
    throw appError("OPENSEARCH_ERROR", `OpenSearch get failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// executeAggregate
// ---------------------------------------------------------------------------

export async function executeAggregate(
  objectTypeApiName: string,
  params: AggregateParams,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Record<string, unknown>> {
  const indexName = getIndexName(objectTypeApiName);

  // Translate filter
  const osQuery = await translateFilter(params.where, objectTypeApiName);

  // Build aggregation clauses
  const aggs: Record<string, unknown> = {};
  for (const def of params.aggregations) {
    aggs[def.name] = buildAggClause(def);
  }

  const body: Record<string, unknown> = {
    size: 0, // no hits, only aggregations
    query: osQuery,
    aggs,
    track_total_hits: true,
  };

  // Inject mandatory security filter (§Task 28) + F-P3-13 branch filter
  const finalBody = injectSecurityFilter(body, securityFilter, branchId);

  let response: any;
  try {
    const result = await client.search({ index: indexName, body: finalBody });
    response = result.body;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return {
        data: {
          totalCount: 0,
          ...Object.fromEntries(params.aggregations.map((a) => [a.name, null])),
        },
      };
    }
    throw appError("OPENSEARCH_ERROR", `OpenSearch aggregate failed: ${err.message}`);
  }

  return formatAggregationResponse(response, params.aggregations);
}

/**
 * Build the OpenSearch sub-aggregation for a bucket's nested metric.
 * Mirrors the leaf-metric clauses in `buildAggClause` but is only ever
 * attached UNDER a `terms` bucket (see the `metric` handling there).
 * `count` returns a `value_count` on `__pk` so the value matches the
 * bucket's own `doc_count`; everything else aggregates over `metric.field`.
 */
function buildMetricClause(metric: { type: string; field?: string }): Record<string, unknown> {
  const f = metric.field;
  switch (metric.type) {
    case "sum":
      return { sum: { field: f } };
    case "avg":
      return { avg: { field: f } };
    case "min":
      return { min: { field: f } };
    case "max":
      return { max: { field: f } };
    case "cardinality":
      return { cardinality: { field: f } };
    case "count":
    default:
      return { value_count: { field: "__pk" } };
  }
}

export function buildAggClause(def: AggregateParams["aggregations"][0]): Record<string, unknown> {
  const fieldName = def.field || "__pk";

  switch (def.type) {
    case "count":
      return { value_count: { field: "__pk" } };
    case "cardinality":
      return { cardinality: { field: fieldName } };
    case "avg":
      return { avg: { field: fieldName } };
    case "sum":
      return { sum: { field: fieldName } };
    case "min":
      return { min: { field: fieldName } };
    case "max":
      return { max: { field: fieldName } };
    case "terms": {
      const clause: Record<string, unknown> = {
        terms: { field: `${fieldName}.keyword`, size: Math.min(def.size || 100, MAX_TERMS_BUCKET_SIZE) },
      };
      const hasMetric = !!def.metric && def.metric.type !== "count";
      const sub: Record<string, unknown> = {};
      if (def.groupBy) {
        // Secondary group-by ("segment by"/series) → a nested `terms` whose
        // own buckets carry the metric (Chart XY multi-series). One request
        // returns the full X × series × Y matrix.
        const seriesAgg: Record<string, unknown> = {
          terms: {
            field: `${def.groupBy.field}.keyword`,
            size: Math.min(def.groupBy.size || 50, MAX_TERMS_BUCKET_SIZE),
          },
        };
        if (hasMetric) seriesAgg.aggs = { metric: buildMetricClause(def.metric!) };
        sub.series = seriesAgg;
      } else if (hasMetric) {
        // Nested per-bucket metric (Pie Chart aggregation method). `count`
        // is a no-op — the bucket's `doc_count` already carries it.
        sub.metric = buildMetricClause(def.metric!);
      }
      if (Object.keys(sub).length > 0) clause.aggs = sub;
      return clause;
    }
    case "date_histogram":
      return {
        date_histogram: {
          field: fieldName,
          calendar_interval: def.interval || "1y",
        },
      };
    case "range":
      return {
        range: {
          field: fieldName,
          ranges: def.ranges || [],
        },
      };
    default:
      return { value_count: { field: fieldName } };
  }
}

// ---------------------------------------------------------------------------
// executeFullTextSearch
// ---------------------------------------------------------------------------

export async function executeFullTextSearch(
  objectTypeApiName: string,
  searchText: string,
  params: SearchParams,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<FormattedListResponse> {
  const indexName = getIndexName(objectTypeApiName);
  const pageSize = params.$pageSize ?? 100;
  const orderBy = params.$orderBy || [];

  // Get all string properties for multi-field search
  const allProps = await resolveAllProperties(objectTypeApiName);
  const textFields: string[] = [];
  for (const [name, meta] of allProps) {
    if (name.startsWith("__")) continue;
    const effective = meta.baseType.endsWith("_array")
      ? meta.baseType.replace("_array", "")
      : meta.baseType;
    if (effective === "string") {
      textFields.push(name);
    }
  }

  if (textFields.length === 0) {
    return { data: [], nextPageToken: null, totalCount: 0 };
  }

  // T-09 (C-153..C-155): Build multi_match query across all text fields,
  // and additionally a `query_string` clause when the search text uses
  // Lucene spec syntax (`~` fuzz, `*?` wildcards, `"phrase"`, `AND/OR/NOT`,
  // parens). Without this branch the executor silently dropped operator
  // semantics on the floor.
  //
  // Hard-set:
  //   - allow_leading_wildcard: false  — leading `*foo` is O(n) on the
  //     term dictionary (per Foundry §3 footnote); operator opt-in via
  //     env if ever needed.
  //   - lenient: true                  — tolerate field-type mismatch on
  //     broad fielded queries; without this, a typo on a numeric field
  //     would 400 the entire search.
  //   - analyze_wildcard               — env-gated. Default off because
  //     analyzed wildcards are an order of magnitude slower than
  //     non-analyzed.
  const SPEC_SYNTAX_RE = /[~*?"]|\b(?:AND|OR|NOT)\b|[()]/;
  const ANALYZE_WILDCARD_ENABLED =
    process.env.TELLUS_FT_ANALYZE_WILDCARD === "true";
  const usesSpecSyntax = SPEC_SYNTAX_RE.test(searchText);
  // Metric label is bounded ("true" | "false"), no user-supplied input.
  incCounter("tellus_full_text_spec_syntax_total", {
    syntax_used: usesSpecSyntax ? "true" : "false",
  });

  const fullTextShould: Record<string, unknown>[] = [
    {
      multi_match: {
        query: searchText,
        fields: textFields,
        type: "cross_fields",
        operator: "and",
      },
    },
    {
      multi_match: {
        query: searchText,
        fields: textFields,
        type: "best_fields",
        fuzziness: "AUTO",
      },
    },
  ];
  if (usesSpecSyntax) {
    fullTextShould.push({
      query_string: {
        query: searchText,
        fields: textFields,
        default_operator: "AND",
        analyze_wildcard: ANALYZE_WILDCARD_ENABLED,
        allow_leading_wildcard: false,
        lenient: true,
      },
    });
  }
  const fullTextQuery: Record<string, unknown> = {
    bool: {
      should: fullTextShould,
      minimum_should_match: 1,
    },
  };

  // Combine with additional where clause if present
  let finalQuery: Record<string, unknown>;
  if (params.where) {
    const filterQuery = await translateFilter(params.where, objectTypeApiName);
    finalQuery = {
      bool: {
        must: [fullTextQuery],
        filter: [filterQuery],
      },
    };
  } else {
    finalQuery = fullTextQuery;
  }

  const sortClause = await buildSortClause(orderBy, objectTypeApiName);

  const body: Record<string, unknown> = {
    size: pageSize + 1,
    query: finalQuery,
    sort: sortClause,
    track_total_hits: true,
    highlight: {
      fields: Object.fromEntries(textFields.map((f) => [f, {}])),
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
    },
  };

  if (params.$pageToken) {
    const decoded = decodePageToken(params.$pageToken, objectTypeApiName, params.where);
    body.search_after = buildSearchAfterClause(decoded);
  }

  if (params.$select && params.$select.length > 0) {
    body._source = [...new Set([...params.$select, "__pk", "__objectType"])];
  }

  // Inject mandatory security filter (§Task 28) + F-P3-13 branch filter
  const finalBody = injectSecurityFilter(body, securityFilter, branchId);

  let response: any;
  try {
    const result = await client.search({ index: indexName, body: finalBody });
    response = result.body;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return { data: [], nextPageToken: null, totalCount: 0 };
    }
    throw appError("OPENSEARCH_ERROR", `OpenSearch full-text search failed: ${err.message}`);
  }

  const allPropNames = [...allProps.keys()].filter((k) => !k.startsWith("__"));
  return formatObjectList(
    response,
    objectTypeApiName,
    allPropNames,
    params.$select,
    orderBy,
    params.where,
    pageSize
  );
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/* v8 ignore start */
if (require.main === module) {
  console.log("=== QueryExecutor self-test ===");
  console.log("  (No offline tests — requires OpenSearch. Tested via integration.)");
  console.log("\n0 passed, 0 failed");
  process.exit(0);
}
/* v8 ignore stop */
