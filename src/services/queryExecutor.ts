// ---------------------------------------------------------------------------
// OpenSearch Query Executor
//
// Orchestrates query execution: translates filters, builds sort/pagination,
// executes against OpenSearch, and formats the response.
//
// Task 8: Core query execution engine
// ---------------------------------------------------------------------------

import { client } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { translateFilter, buildSortClause } from "./queryTranslator";
import { resolveAllProperties } from "./propertyResolver";
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
  }>;
}

// ---------------------------------------------------------------------------
// executeSearch
// ---------------------------------------------------------------------------

export async function executeSearch(
  objectTypeApiName: string,
  params: SearchParams
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

  // Execute
  let response: any;
  try {
    const result = await client.search({ index: indexName, body });
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
  primaryKey: string
): Promise<Record<string, unknown> | null> {
  const indexName = getIndexName(objectTypeApiName);

  try {
    const { body } = await client.get({ index: indexName, id: primaryKey });
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
  params: AggregateParams
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

  let response: any;
  try {
    const result = await client.search({ index: indexName, body });
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

function buildAggClause(def: AggregateParams["aggregations"][0]): Record<string, unknown> {
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
    case "terms":
      return { terms: { field: `${fieldName}.keyword`, size: def.size || 100 } };
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
  params: SearchParams
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

  // Build multi_match query across all text fields.
  // Use cross_fields for multi-term cross-field matching. Fuzziness is applied
  // via a separate bool/should clause because cross_fields does not support
  // fuzziness in OpenSearch. The primary clause uses cross_fields + operator:and
  // for exact token matching; the secondary clause uses best_fields + fuzziness
  // for typo tolerance.
  const fullTextQuery: Record<string, unknown> = {
    bool: {
      should: [
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
      ],
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

  let response: any;
  try {
    const result = await client.search({ index: indexName, body });
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
