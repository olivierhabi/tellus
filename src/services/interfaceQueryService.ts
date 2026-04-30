// ---------------------------------------------------------------------------
// Interface Query Service
//
// Encapsulates the polymorphic query and aggregation logic for Interfaces.
// Called by the Interface search/aggregate route handlers.
//
// Task 10: executePolymorphicSearch, executePolymorphicAggregation,
//          translateInterfaceQuery, mergeAggregationResults
// ---------------------------------------------------------------------------

import { query } from "../db";
import { client as osClient } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { translateFilter, buildSortClause } from "./queryTranslator";
import { appError } from "../utils/appError";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolymorphicSearchOptions {
  pageSize: number;
  pageToken: string | null;
  orderBy: Array<{ field: string; direction: string }>;
  select: string[] | null;
}

export interface PolymorphicSearchResult {
  data: Array<Record<string, unknown>>;
  nextPageToken: string | null;
  totalCount: number;
}

export interface AggregationSpec {
  name: string;
  type: string;
  field?: string;
  size?: number;
  interval?: string;
  ranges?: Array<{ key?: string; from?: unknown; to?: unknown }>;
}

interface ImplementingType {
  objectTypeApiName: string;
  propertyMapping: Record<string, string>;
}

interface InterfaceProperty {
  apiName: string;
  baseType: string;
  isRequired: boolean;
}

// ---------------------------------------------------------------------------
// Internal: fetch interface properties
// ---------------------------------------------------------------------------

async function getInterfaceProperties(
  interfaceId: string
): Promise<InterfaceProperty[]> {
  const result = await query(
    `SELECT api_name, base_type, is_required
     FROM interface_property
     WHERE interface_id = $1
     ORDER BY ordinal`,
    [interfaceId]
  );
  return result.rows.map((r: any) => ({
    apiName: r.api_name,
    baseType: r.base_type,
    isRequired: r.is_required,
  }));
}

// ---------------------------------------------------------------------------
// Internal: fetch implementing object types
// ---------------------------------------------------------------------------

async function getImplementingTypes(
  interfaceId: string
): Promise<ImplementingType[]> {
  const result = await query(
    `SELECT ot.api_name AS object_type_api_name, oti.property_mapping
     FROM object_type_interface oti
     JOIN object_type ot ON ot.object_type_id = oti.object_type_id
     WHERE oti.interface_id = $1`,
    [interfaceId]
  );
  return result.rows.map((r: any) => ({
    objectTypeApiName: r.object_type_api_name,
    propertyMapping: r.property_mapping as Record<string, string>,
  }));
}

// ---------------------------------------------------------------------------
// translateInterfaceQuery
//
// Recursively walks the query DSL tree and replaces Interface field names
// with Object Type field names using the property mapping.
// Returns null if a required field is unmapped (signals to skip this OT).
// ---------------------------------------------------------------------------

export function translateInterfaceQuery(
  node: any,
  mapping: Record<string, string>
): any | null {
  if (!node || !node.type) {
    return node; // null/undefined/empty → pass through (match_all)
  }

  // Compound operators: and, or, not
  if (node.type === "and") {
    const translated: any[] = [];
    for (const child of node.value || []) {
      const result = translateInterfaceQuery(child, mapping);
      if (result === null) {
        // A required sub-filter is unmapped — entire AND fails
        return null;
      }
      translated.push(result);
    }
    return { type: "and", value: translated };
  }

  if (node.type === "or") {
    const translated: any[] = [];
    for (const child of node.value || []) {
      const result = translateInterfaceQuery(child, mapping);
      if (result !== null) {
        translated.push(result);
      }
      // null branches in OR are dropped (other branches still valid)
    }
    if (translated.length === 0) {
      return null; // All OR branches unmapped
    }
    return { type: "or", value: translated };
  }

  if (node.type === "not") {
    const inner = translateInterfaceQuery(
      (node.value || [])[0],
      mapping
    );
    if (inner === null) return null;
    return { type: "not", value: [inner] };
  }

  // Leaf nodes: eq, gt, gte, lt, lte, contains, startsWith, isNull, isNotNull, in
  if (node.field) {
    // System fields don't need translation
    if (node.field.startsWith("__")) {
      return node;
    }

    const mappedField = mapping[node.field];
    if (!mappedField) {
      // This Object Type doesn't map this Interface field
      return null;
    }
    return { ...node, field: mappedField };
  }

  // Pass through unknown nodes
  return node;
}

// ---------------------------------------------------------------------------
// translateOrderBy
//
// Translates orderBy fields from Interface names to OT names.
// Returns null if any required field is unmapped.
// ---------------------------------------------------------------------------

function translateOrderBy(
  orderBy: Array<{ field: string; direction: string }>,
  mapping: Record<string, string>
): Array<{ field: string; direction: string }> | null {
  const translated: Array<{ field: string; direction: string }> = [];
  for (const item of orderBy) {
    if (item.field.startsWith("__")) {
      translated.push(item);
      continue;
    }
    const mapped = mapping[item.field];
    if (!mapped) {
      return null; // Can't sort on unmapped field
    }
    translated.push({ field: mapped, direction: item.direction });
  }
  return translated;
}

// ---------------------------------------------------------------------------
// executePolymorphicSearch (Task 8)
//
// 1. Look up Interface properties and implementing OTs
// 2. Translate query per OT
// 3. Execute _msearch across all OT indices
// 4. Merge, sort, paginate
// ---------------------------------------------------------------------------

export async function executePolymorphicSearch(
  interfaceId: string,
  whereClause: any,
  options: PolymorphicSearchOptions
): Promise<PolymorphicSearchResult> {
  const interfaceProps = await getInterfaceProperties(interfaceId);
  const implementingTypes = await getImplementingTypes(interfaceId);

  // No implementing types → empty result
  if (implementingTypes.length === 0) {
    return { data: [], nextPageToken: null, totalCount: 0 };
  }

  // Build inverted mapping (Interface prop → name) for reverse-mapping results
  const interfacePropNames = new Set(interfaceProps.map((p) => p.apiName));

  // For each implementing type, translate the query and prepare search bodies
  const searchBodies: Array<{
    objectTypeApiName: string;
    indexName: string;
    body: Record<string, unknown>;
    mapping: Record<string, string>;
    reverseMapping: Record<string, string>;
  }> = [];

  for (const impl of implementingTypes) {
    const { objectTypeApiName, propertyMapping } = impl;

    // Translate the where clause
    const translatedWhere = translateInterfaceQuery(
      whereClause,
      propertyMapping
    );

    // If translation returned null, this OT can't satisfy the filter
    if (translatedWhere === null && whereClause && whereClause.type) {
      continue;
    }

    // Translate orderBy
    let translatedOrderBy = options.orderBy;
    if (options.orderBy && options.orderBy.length > 0) {
      const result = translateOrderBy(options.orderBy, propertyMapping);
      if (result === null) {
        // Can't sort on unmapped field — include but mark for nulls-last
        translatedOrderBy = [];
      } else {
        translatedOrderBy = result;
      }
    }

    // Build the OpenSearch query
    const indexName = getIndexName(objectTypeApiName);
    const osQuery = await translateFilter(
      translatedWhere,
      objectTypeApiName
    );

    // Build reverse mapping (OT prop → Interface prop)
    const reverseMapping: Record<string, string> = {};
    for (const [ifProp, otProp] of Object.entries(propertyMapping)) {
      reverseMapping[otProp] = ifProp;
    }

    // Request enough docs to fill the merged page
    // We request a large window: pageSize * number_of_types to ensure
    // we have enough for sorting across types
    const fetchSize = options.pageSize * implementingTypes.length + 1;

    const body: Record<string, unknown> = {
      size: fetchSize,
      query: osQuery,
      track_total_hits: true,
    };

    // Handle $select: translate interface prop names to OT prop names
    if (options.select && options.select.length > 0) {
      const sourceFields = new Set(["__pk", "__objectType"]);
      for (const field of options.select) {
        if (field.startsWith("__")) {
          sourceFields.add(field);
        } else {
          const otField = propertyMapping[field];
          if (otField) sourceFields.add(otField);
        }
      }
      body._source = Array.from(sourceFields);
    }

    searchBodies.push({
      objectTypeApiName,
      indexName,
      body,
      mapping: propertyMapping,
      reverseMapping,
    });
  }

  // No valid types → empty result
  if (searchBodies.length === 0) {
    return { data: [], nextPageToken: null, totalCount: 0 };
  }

  // Execute _msearch
  const msearchBody: any[] = [];
  for (const sb of searchBodies) {
    msearchBody.push({ index: sb.indexName });
    msearchBody.push(sb.body);
  }

  let msearchResponse: any;
  try {
    const result = await osClient.msearch({ body: msearchBody });
    msearchResponse = result.body;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return { data: [], nextPageToken: null, totalCount: 0 };
    }
    throw appError(
      "OPENSEARCH_ERROR",
      `OpenSearch multi-search failed: ${err.message}`
    );
  }

  // Merge results from all types
  const allObjects: Array<Record<string, unknown>> = [];
  let totalCount = 0;

  const responses = msearchResponse.responses || [];
  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i];
    if (resp.error) {
      // Skip indices that error (e.g., index not found)
      console.warn(
        `[INTERFACE_SEARCH] Index ${searchBodies[i].indexName} error: ${JSON.stringify(resp.error)}`
      );
      continue;
    }

    const hits = resp.hits?.hits || [];
    const typeTotal =
      typeof resp.hits?.total === "object"
        ? resp.hits.total.value
        : resp.hits?.total ?? 0;
    totalCount += typeTotal;

    const { objectTypeApiName, reverseMapping } = searchBodies[i];

    for (const hit of hits) {
      const source = hit._source || {};
      const obj: Record<string, unknown> = {
        __primaryKey: source.__pk || hit._id,
        __objectType: objectTypeApiName,
      };

      // Map OT properties back to Interface property names
      for (const [otProp, value] of Object.entries(source)) {
        if (otProp === "__pk" || otProp === "__objectType" || otProp === "__version") {
          continue;
        }
        const ifProp = reverseMapping[otProp];
        if (ifProp) {
          obj[ifProp] = value;
        }
      }

      // Fill in unmapped optional properties with null (for $select)
      if (options.select) {
        for (const field of options.select) {
          if (!(field in obj) && !field.startsWith("__")) {
            obj[field] = null;
          }
        }
      } else {
        // Fill all interface properties
        for (const prop of interfaceProps) {
          if (!(prop.apiName in obj)) {
            obj[prop.apiName] = null;
          }
        }
      }

      allObjects.push(obj);
    }
  }

  // Sort the merged results
  if (options.orderBy && options.orderBy.length > 0) {
    allObjects.sort((a, b) => {
      for (const item of options.orderBy) {
        const field = item.field;
        const dir = item.direction === "desc" ? -1 : 1;
        const aVal = a[field];
        const bVal = b[field];

        // Nulls last
        if (aVal === null || aVal === undefined) {
          if (bVal !== null && bVal !== undefined) return 1;
          continue;
        }
        if (bVal === null || bVal === undefined) return -1;

        if (aVal < bVal) return -1 * dir;
        if (aVal > bVal) return 1 * dir;
      }
      return 0;
    });
  }

  // Pagination via offset-based slicing with base64 pageToken
  let offset = 0;
  if (options.pageToken) {
    try {
      const decoded = JSON.parse(
        Buffer.from(options.pageToken, "base64").toString()
      );
      offset = decoded.offset || 0;
    } catch {
      throw appError("INVALID_PAGE_TOKEN", "Invalid page token.");
    }
  }

  const pageSize = options.pageSize;
  const paged = allObjects.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < allObjects.length;
  const nextPageToken = hasMore
    ? Buffer.from(JSON.stringify({ offset: offset + pageSize })).toString(
        "base64"
      )
    : null;

  return {
    data: paged,
    nextPageToken,
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// mergeAggregationResults (Task 9)
//
// Merges per-OT aggregation responses according to aggregation type.
// ---------------------------------------------------------------------------

export function mergeAggregationResults(
  perTypeResults: Array<{
    objectTypeApiName: string;
    aggregations: any;
    totalCount: number;
  }>,
  aggregationSpec: AggregationSpec[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  // Calculate total count across all types
  let totalCount = 0;
  for (const r of perTypeResults) {
    totalCount += r.totalCount;
  }

  for (const spec of aggregationSpec) {
    const name = spec.name;
    const type = spec.type;

    switch (type) {
      case "count": {
        // Sum value_count from all types
        let total = 0;
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg) {
            total += agg.value ?? 0;
          }
        }
        merged[name] = total;
        break;
      }

      case "avg": {
        // Weighted average: need sum and count from stats aggregation
        let totalSum = 0;
        let totalCnt = 0;
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg) {
            // We request stats aggregation to get sum and count
            totalSum += agg.sum ?? 0;
            totalCnt += agg.count ?? 0;
          }
        }
        merged[name] = totalCnt > 0 ? totalSum / totalCnt : null;
        break;
      }

      case "sum": {
        let total = 0;
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg) {
            total += agg.value ?? 0;
          }
        }
        merged[name] = total;
        break;
      }

      case "min": {
        let min: number | null = null;
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg && agg.value !== null && agg.value !== undefined) {
            if (min === null || agg.value < min) {
              min = agg.value;
            }
          }
        }
        merged[name] = min;
        break;
      }

      case "max": {
        let max: number | null = null;
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg && agg.value !== null && agg.value !== undefined) {
            if (max === null || agg.value > max) {
              max = agg.value;
            }
          }
        }
        merged[name] = max;
        break;
      }

      case "terms": {
        // Merge term buckets, summing counts for matching keys
        const bucketMap = new Map<string, number>();
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg?.buckets) {
            for (const bucket of agg.buckets) {
              const key = String(bucket.key);
              bucketMap.set(
                key,
                (bucketMap.get(key) || 0) + (bucket.doc_count ?? 0)
              );
            }
          }
        }
        // Sort by count descending, truncate to size
        const sortedBuckets = Array.from(bucketMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, spec.size || 100)
          .map(([key, count]) => ({ key, count }));
        merged[name] = sortedBuckets;
        break;
      }

      case "date_histogram": {
        // Merge date histogram buckets by key
        const dateBucketMap = new Map<string, number>();
        for (const r of perTypeResults) {
          const agg = r.aggregations?.[name];
          if (agg?.buckets) {
            for (const bucket of agg.buckets) {
              const key = bucket.key_as_string || String(bucket.key);
              dateBucketMap.set(
                key,
                (dateBucketMap.get(key) || 0) + (bucket.doc_count ?? 0)
              );
            }
          }
        }
        const sortedDateBuckets = Array.from(dateBucketMap.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([key, count]) => ({ key, count }));
        merged[name] = sortedDateBuckets;
        break;
      }

      default: {
        // Unsupported aggregation — pass null
        merged[name] = null;
        break;
      }
    }
  }

  return { data: { totalCount, ...merged } };
}

// ---------------------------------------------------------------------------
// buildAggClauseForInterface
//
// Builds OpenSearch aggregation clauses, using stats instead of avg
// for correct cross-index weighted averaging.
// ---------------------------------------------------------------------------

function buildAggClauseForInterface(
  spec: AggregationSpec,
  fieldMapping: Record<string, string>
): Record<string, unknown> {
  const rawField = spec.field || "__pk";
  // Translate interface field name to OT field name
  const fieldName = rawField.startsWith("__")
    ? rawField
    : fieldMapping[rawField] || rawField;

  switch (spec.type) {
    case "count":
      return { value_count: { field: "__pk" } };
    case "avg":
      // Use stats to get sum+count for weighted averaging
      return { stats: { field: fieldName } };
    case "sum":
      return { sum: { field: fieldName } };
    case "min":
      return { min: { field: fieldName } };
    case "max":
      return { max: { field: fieldName } };
    case "terms": {
      // Request size * 2 for merging heuristic
      const size = (spec.size || 100) * 2;
      const termField =
        fieldName === "__objectType" || fieldName === "__pk"
          ? fieldName
          : `${fieldName}.keyword`;
      return { terms: { field: termField, size } };
    }
    case "date_histogram":
      return {
        date_histogram: {
          field: fieldName,
          calendar_interval: spec.interval || "1y",
        },
      };
    default:
      return { value_count: { field: fieldName } };
  }
}

// ---------------------------------------------------------------------------
// executePolymorphicAggregation (Task 9)
//
// Same pattern as search: translate per-OT, execute _msearch, merge.
// ---------------------------------------------------------------------------

export async function executePolymorphicAggregation(
  interfaceId: string,
  whereClause: any,
  aggregations: AggregationSpec[]
): Promise<Record<string, unknown>> {
  const implementingTypes = await getImplementingTypes(interfaceId);

  // No implementing types → return zeros
  if (implementingTypes.length === 0) {
    const emptyData: Record<string, unknown> = { totalCount: 0 };
    for (const spec of aggregations) {
      if (spec.type === "terms" || spec.type === "date_histogram") {
        emptyData[spec.name] = [];
      } else if (spec.type === "avg") {
        emptyData[spec.name] = null;
      } else {
        emptyData[spec.name] = 0;
      }
    }
    return { data: emptyData };
  }

  // Build per-OT search bodies
  const searchBodies: Array<{
    objectTypeApiName: string;
    indexName: string;
    body: Record<string, unknown>;
    mapping: Record<string, string>;
  }> = [];

  for (const impl of implementingTypes) {
    const { objectTypeApiName, propertyMapping } = impl;

    // Translate where clause
    const translatedWhere = translateInterfaceQuery(
      whereClause,
      propertyMapping
    );
    if (translatedWhere === null && whereClause && whereClause.type) {
      continue; // Skip — filter references unmapped field
    }

    const indexName = getIndexName(objectTypeApiName);
    const osQuery = await translateFilter(
      translatedWhere,
      objectTypeApiName
    );

    // Build aggregation clauses
    const aggs: Record<string, unknown> = {};
    let skipType = false;
    for (const spec of aggregations) {
      // Check if the aggregation field is mapped
      if (
        spec.field &&
        !spec.field.startsWith("__") &&
        !propertyMapping[spec.field]
      ) {
        // Unmapped aggregation field — skip this OT for this agg
        // We still include the type but this specific agg will be empty
      }
      aggs[spec.name] = buildAggClauseForInterface(spec, propertyMapping);
    }

    const body: Record<string, unknown> = {
      size: 0,
      query: osQuery,
      aggs,
      track_total_hits: true,
    };

    searchBodies.push({
      objectTypeApiName,
      indexName,
      body,
      mapping: propertyMapping,
    });
  }

  // No valid types → return zeros
  if (searchBodies.length === 0) {
    const emptyData: Record<string, unknown> = { totalCount: 0 };
    for (const spec of aggregations) {
      if (spec.type === "terms" || spec.type === "date_histogram") {
        emptyData[spec.name] = [];
      } else if (spec.type === "avg") {
        emptyData[spec.name] = null;
      } else {
        emptyData[spec.name] = 0;
      }
    }
    return { data: emptyData };
  }

  // Execute _msearch
  const msearchBody: any[] = [];
  for (const sb of searchBodies) {
    msearchBody.push({ index: sb.indexName });
    msearchBody.push(sb.body);
  }

  let msearchResponse: any;
  try {
    const result = await osClient.msearch({ body: msearchBody });
    msearchResponse = result.body;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      const emptyData: Record<string, unknown> = { totalCount: 0 };
      for (const spec of aggregations) {
        emptyData[spec.name] = spec.type === "avg" ? null : 0;
      }
      return { data: emptyData };
    }
    throw appError(
      "OPENSEARCH_ERROR",
      `OpenSearch multi-search aggregate failed: ${err.message}`
    );
  }

  // Collect per-type results
  const perTypeResults: Array<{
    objectTypeApiName: string;
    aggregations: any;
    totalCount: number;
  }> = [];

  const responses = msearchResponse.responses || [];
  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i];
    if (resp.error) {
      console.warn(
        `[INTERFACE_AGG] Index ${searchBodies[i].indexName} error: ${JSON.stringify(resp.error)}`
      );
      continue;
    }

    const typeTotal =
      typeof resp.hits?.total === "object"
        ? resp.hits.total.value
        : resp.hits?.total ?? 0;

    perTypeResults.push({
      objectTypeApiName: searchBodies[i].objectTypeApiName,
      aggregations: resp.aggregations || {},
      totalCount: typeTotal,
    });
  }

  return mergeAggregationResults(perTypeResults, aggregations);
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/interfaceQueryService.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS  ${label}`);
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL  ${label}`);
    }
  }

  console.log("=== InterfaceQueryService self-tests ===\n");

  // -----------------------------------------------------------------------
  // Test translateInterfaceQuery
  // -----------------------------------------------------------------------

  const mapping = {
    latitude: "airportLat",
    longitude: "airportLng",
    locationName: "airportName",
  };

  // Test 1: Simple leaf translation
  const t1 = translateInterfaceQuery(
    { type: "eq", field: "latitude", value: -1.9 },
    mapping
  );
  assert(
    t1 !== null && t1.field === "airportLat" && t1.value === -1.9,
    "eq leaf: latitude → airportLat"
  );

  // Test 2: Unmapped field → null
  const t2 = translateInterfaceQuery(
    { type: "eq", field: "unmapped", value: "test" },
    mapping
  );
  assert(t2 === null, "unmapped leaf → null");

  // Test 3: System field pass-through
  const t3 = translateInterfaceQuery(
    { type: "eq", field: "__pk", value: "ABC" },
    mapping
  );
  assert(
    t3 !== null && t3.field === "__pk",
    "system field __pk passes through"
  );

  // Test 4: AND with all mapped fields
  const t4 = translateInterfaceQuery(
    {
      type: "and",
      value: [
        { type: "gt", field: "latitude", value: -2.0 },
        { type: "lt", field: "longitude", value: 31.0 },
      ],
    },
    mapping
  );
  assert(
    t4 !== null &&
      t4.type === "and" &&
      t4.value.length === 2 &&
      t4.value[0].field === "airportLat" &&
      t4.value[1].field === "airportLng",
    "AND: both fields translated"
  );

  // Test 5: AND with unmapped field → null (entire AND fails)
  const t5 = translateInterfaceQuery(
    {
      type: "and",
      value: [
        { type: "eq", field: "latitude", value: 1.0 },
        { type: "eq", field: "unmapped", value: "x" },
      ],
    },
    mapping
  );
  assert(t5 === null, "AND with unmapped field → null");

  // Test 6: OR with one unmapped field → only mapped branch kept
  const t6 = translateInterfaceQuery(
    {
      type: "or",
      value: [
        { type: "eq", field: "latitude", value: 1.0 },
        { type: "eq", field: "unmapped", value: "x" },
      ],
    },
    mapping
  );
  assert(
    t6 !== null &&
      t6.type === "or" &&
      t6.value.length === 1 &&
      t6.value[0].field === "airportLat",
    "OR: unmapped branch dropped, mapped branch kept"
  );

  // Test 7: OR with all unmapped → null
  const t7 = translateInterfaceQuery(
    {
      type: "or",
      value: [
        { type: "eq", field: "unmapped1", value: 1 },
        { type: "eq", field: "unmapped2", value: 2 },
      ],
    },
    mapping
  );
  assert(t7 === null, "OR with all unmapped → null");

  // Test 8: NOT with mapped field
  const t8 = translateInterfaceQuery(
    {
      type: "not",
      value: [{ type: "eq", field: "latitude", value: 0 }],
    },
    mapping
  );
  assert(
    t8 !== null &&
      t8.type === "not" &&
      t8.value[0].field === "airportLat",
    "NOT: field translated"
  );

  // Test 9: NOT with unmapped → null
  const t9 = translateInterfaceQuery(
    {
      type: "not",
      value: [{ type: "eq", field: "unmapped", value: 0 }],
    },
    mapping
  );
  assert(t9 === null, "NOT with unmapped → null");

  // Test 10: null/empty input
  const t10 = translateInterfaceQuery(null, mapping);
  assert(t10 === null, "null input → null (pass-through)");

  const t11 = translateInterfaceQuery({}, mapping);
  assert(
    t11 !== null && Object.keys(t11).length === 0,
    "empty object → pass-through"
  );

  // -----------------------------------------------------------------------
  // Test mergeAggregationResults
  // -----------------------------------------------------------------------

  // Test: count merge
  const countResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "Airport",
        aggregations: { total: { value: 5 } },
        totalCount: 5,
      },
      {
        objectTypeApiName: "Warehouse",
        aggregations: { total: { value: 3 } },
        totalCount: 3,
      },
    ],
    [{ name: "total", type: "count" }]
  );
  assert(
    (countResult.data as any).totalCount === 8,
    "count merge: totalCount = 8"
  );
  assert(
    (countResult.data as any).total === 8,
    "count merge: total = 5 + 3"
  );

  // Test: weighted avg merge
  const avgResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "Airport",
        aggregations: { avgLat: { sum: 10.0, count: 5 } },
        totalCount: 5,
      },
      {
        objectTypeApiName: "Warehouse",
        aggregations: { avgLat: { sum: 6.0, count: 3 } },
        totalCount: 3,
      },
    ],
    [{ name: "avgLat", type: "avg", field: "latitude" }]
  );
  const avgValue = (avgResult.data as any).avgLat;
  assert(
    Math.abs(avgValue - 2.0) < 0.0001,
    `weighted avg: (10+6)/(5+3) = 2.0, got ${avgValue}`
  );

  // Test: avg with zero count → null
  const avgZero = mergeAggregationResults(
    [
      {
        objectTypeApiName: "Empty",
        aggregations: { avgLat: { sum: 0, count: 0 } },
        totalCount: 0,
      },
    ],
    [{ name: "avgLat", type: "avg", field: "latitude" }]
  );
  assert(
    (avgZero.data as any).avgLat === null,
    "avg with zero count → null"
  );

  // Test: sum merge
  const sumResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "A",
        aggregations: { totalVal: { value: 100 } },
        totalCount: 5,
      },
      {
        objectTypeApiName: "B",
        aggregations: { totalVal: { value: 200 } },
        totalCount: 3,
      },
    ],
    [{ name: "totalVal", type: "sum", field: "amount" }]
  );
  assert(
    (sumResult.data as any).totalVal === 300,
    "sum merge: 100 + 200 = 300"
  );

  // Test: min merge
  const minResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "A",
        aggregations: { minLat: { value: -2.5 } },
        totalCount: 5,
      },
      {
        objectTypeApiName: "B",
        aggregations: { minLat: { value: -1.0 } },
        totalCount: 3,
      },
    ],
    [{ name: "minLat", type: "min", field: "latitude" }]
  );
  assert(
    (minResult.data as any).minLat === -2.5,
    "min merge: min(-2.5, -1.0) = -2.5"
  );

  // Test: max merge
  const maxResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "A",
        aggregations: { maxLat: { value: 5.0 } },
        totalCount: 5,
      },
      {
        objectTypeApiName: "B",
        aggregations: { maxLat: { value: 10.0 } },
        totalCount: 3,
      },
    ],
    [{ name: "maxLat", type: "max", field: "latitude" }]
  );
  assert(
    (maxResult.data as any).maxLat === 10.0,
    "max merge: max(5, 10) = 10"
  );

  // Test: terms merge
  const termsResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "A",
        aggregations: {
          byType: {
            buckets: [
              { key: "Airport", doc_count: 5 },
              { key: "Shared", doc_count: 2 },
            ],
          },
        },
        totalCount: 7,
      },
      {
        objectTypeApiName: "B",
        aggregations: {
          byType: {
            buckets: [
              { key: "Warehouse", doc_count: 3 },
              { key: "Shared", doc_count: 1 },
            ],
          },
        },
        totalCount: 4,
      },
    ],
    [{ name: "byType", type: "terms", field: "__objectType", size: 10 }]
  );
  const termsBuckets = (termsResult.data as any).byType as Array<{
    key: string;
    count: number;
  }>;
  assert(
    termsBuckets.length === 3,
    `terms merge: 3 unique buckets (got ${termsBuckets.length})`
  );
  const airportBucket = termsBuckets.find((b) => b.key === "Airport");
  assert(
    airportBucket?.count === 5,
    `terms merge: Airport count = 5`
  );
  const sharedBucket = termsBuckets.find((b) => b.key === "Shared");
  assert(
    sharedBucket?.count === 3,
    `terms merge: Shared count = 2 + 1 = 3`
  );

  // Test: date_histogram merge
  const dateResult = mergeAggregationResults(
    [
      {
        objectTypeApiName: "A",
        aggregations: {
          byMonth: {
            buckets: [
              { key_as_string: "2025-01", doc_count: 10 },
              { key_as_string: "2025-02", doc_count: 5 },
            ],
          },
        },
        totalCount: 15,
      },
      {
        objectTypeApiName: "B",
        aggregations: {
          byMonth: {
            buckets: [
              { key_as_string: "2025-01", doc_count: 3 },
              { key_as_string: "2025-03", doc_count: 7 },
            ],
          },
        },
        totalCount: 10,
      },
    ],
    [{ name: "byMonth", type: "date_histogram", field: "createdAt", interval: "month" }]
  );
  const dateBuckets = (dateResult.data as any).byMonth as Array<{
    key: string;
    count: number;
  }>;
  assert(
    dateBuckets.length === 3,
    `date_histogram: 3 unique months (got ${dateBuckets.length})`
  );
  const jan = dateBuckets.find((b) => b.key === "2025-01");
  assert(
    jan?.count === 13,
    `date_histogram: Jan = 10 + 3 = 13`
  );

  // Test: empty perTypeResults
  const emptyResult = mergeAggregationResults(
    [],
    [
      { name: "cnt", type: "count" },
      { name: "avgLat", type: "avg", field: "latitude" },
      { name: "byType", type: "terms", field: "__objectType" },
    ]
  );
  assert(
    (emptyResult.data as any).totalCount === 0,
    "empty: totalCount = 0"
  );
  assert(
    (emptyResult.data as any).cnt === 0,
    "empty: count = 0"
  );
  assert(
    (emptyResult.data as any).avgLat === null,
    "empty: avg = null (not NaN)"
  );
  assert(
    Array.isArray((emptyResult.data as any).byType) &&
      (emptyResult.data as any).byType.length === 0,
    "empty: terms = []"
  );

  // Test: function exports exist
  assert(
    typeof executePolymorphicSearch === "function",
    "executePolymorphicSearch is exported"
  );
  assert(
    typeof executePolymorphicAggregation === "function",
    "executePolymorphicAggregation is exported"
  );
  assert(
    typeof translateInterfaceQuery === "function",
    "translateInterfaceQuery is exported"
  );
  assert(
    typeof mergeAggregationResults === "function",
    "mergeAggregationResults is exported"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("\nAll interfaceQueryService self-tests passed.");
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
