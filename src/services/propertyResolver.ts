// ---------------------------------------------------------------------------
// Property Resolver Service
//
// Resolves property metadata for query translation. Before any query can be
// translated into OpenSearch Query DSL, the system must know the exact base
// type of every property being queried. This service provides that mapping.
//
// Key responsibilities:
//   - Resolve a single property's metadata (type, field names, capabilities)
//   - Resolve ALL properties for an object type
//   - Determine the correct OpenSearch field name for a given filter operation
//   - Validate that a property exists on an object type
//   - Cache metadata in memory with 60s TTL
//   - Handle system fields (__pk, __objectType, __lastModified, __version)
// ---------------------------------------------------------------------------

import { query } from "../db";
import { appError } from "../utils/appError";
import { PROPERTY_CACHE_TTL_MS } from "../utils/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropertyMeta {
  propertyId: string;
  apiName: string;
  displayName: string;
  baseType: string;
  isArray: boolean;
  isRequired: boolean;
  opensearchField: string;
  opensearchKeywordField: string;
  opensearchFieldType: string;
  supportsExactMatch: boolean;
  supportsRangeMatch: boolean;
  supportsFullText: boolean;
  supportsGeoQueries: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = PROPERTY_CACHE_TTL_MS;

/** Numeric base types that support range queries and term queries directly. */
const NUMERIC_TYPES = new Set([
  "integer", "long", "double", "float", "byte", "short", "decimal",
]);

/** Integer-family types (no floating point). */
const INTEGER_TYPES = new Set(["integer", "long", "byte", "short"]);

/** Date/time types that support range queries. */
const DATE_TYPES = new Set(["date", "timestamp"]);

/** Geo types that require specialized queries. */
const GEO_TYPES = new Set(["geopoint", "geoshape"]);

/** Filter types that check equality / set membership. */
const EXACT_FILTERS = new Set(["eq", "in"]);

/** Filter types that check ranges. */
const RANGE_FILTERS = new Set(["gt", "gte", "lt", "lte"]);

/** Null-check filter types. */
const NULL_FILTERS = new Set(["isNull", "isNotNull"]);

// ---------------------------------------------------------------------------
// OpenSearch type mapping
// ---------------------------------------------------------------------------

function baseTypeToOsFieldType(baseType: string): string {
  switch (baseType) {
    case "string":
    case "string_array":
      return "text";
    case "integer":
    case "integer_array":
      return "integer";
    case "long":
      return "long";
    case "double":
    case "double_array":
    case "decimal":
      return "double";
    case "float":
      return "float";
    case "byte":
      return "byte";
    case "short":
      return "short";
    case "boolean":
    case "boolean_array":
      return "boolean";
    case "date":
      return "date";
    case "timestamp":
    case "timestamp_array":
      return "date";
    case "geopoint":
      return "geo_point";
    case "geoshape":
      return "geo_shape";
    case "struct":
      return "object";
    case "keyword":
      return "keyword";
    default:
      return "text";
  }
}

/** Extract the "base" type from array types (e.g. string_array → string). */
function getEffectiveBaseType(baseType: string): string {
  if (baseType.endsWith("_array")) {
    return baseType.replace("_array", "");
  }
  return baseType;
}

function buildPropertyMeta(row: {
  propertyId: string;
  apiName: string;
  displayName: string;
  baseType: string;
  isArray: boolean;
  isRequired: boolean;
}): PropertyMeta {
  const effective = getEffectiveBaseType(row.baseType);
  const osFieldType = baseTypeToOsFieldType(row.baseType);
  const isText = effective === "string";
  const isNumeric = NUMERIC_TYPES.has(effective);
  const isDate = DATE_TYPES.has(effective);
  const isGeo = GEO_TYPES.has(effective);
  const isStruct = effective === "struct";
  const isKeyword = effective === "keyword";

  return {
    propertyId: row.propertyId,
    apiName: row.apiName,
    displayName: row.displayName,
    baseType: row.baseType,
    isArray: row.isArray,
    isRequired: row.isRequired,
    opensearchField: row.apiName,
    opensearchKeywordField: isText ? `${row.apiName}.keyword` : row.apiName,
    opensearchFieldType: osFieldType,
    supportsExactMatch: !isGeo && !isStruct,
    supportsRangeMatch: isNumeric || isDate || isText || isKeyword,
    supportsFullText: isText,
    supportsGeoQueries: isGeo,
  };
}

// ---------------------------------------------------------------------------
// System fields — always available, never in PostgreSQL
// ---------------------------------------------------------------------------

const SYSTEM_FIELDS: Record<string, PropertyMeta> = {
  __pk: buildPropertyMeta({
    propertyId: "system:__pk",
    apiName: "__pk",
    displayName: "Primary Key",
    baseType: "keyword",
    isArray: false,
    isRequired: true,
  }),
  __objectType: buildPropertyMeta({
    propertyId: "system:__objectType",
    apiName: "__objectType",
    displayName: "Object Type",
    baseType: "keyword",
    isArray: false,
    isRequired: true,
  }),
  __lastModified: buildPropertyMeta({
    propertyId: "system:__lastModified",
    apiName: "__lastModified",
    displayName: "Last Modified",
    baseType: "timestamp",
    isArray: false,
    isRequired: false,
  }),
  __version: buildPropertyMeta({
    propertyId: "system:__version",
    apiName: "__version",
    displayName: "Version",
    baseType: "long",
    isArray: false,
    isRequired: false,
  }),
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  meta: PropertyMeta;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): PropertyMeta | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.meta;
}

function setCache(key: string, meta: PropertyMeta): void {
  cache.set(key, { meta, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Invalidate all cached entries for a given object type.
 */
export function invalidateCache(objectTypeApiName?: string): void {
  if (!objectTypeApiName) {
    cache.clear();
    return;
  }
  const prefix = `${objectTypeApiName}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Resolve a single property's metadata.
 */
export async function resolveProperty(
  objectTypeApiName: string,
  propertyApiName: string
): Promise<PropertyMeta> {
  // System fields — no DB query needed
  if (SYSTEM_FIELDS[propertyApiName]) {
    return SYSTEM_FIELDS[propertyApiName];
  }

  // Check cache
  const cacheKey = `${objectTypeApiName}:${propertyApiName}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Query PostgreSQL
  const result = await query(
    `SELECT p.property_id  AS "propertyId",
            p.api_name     AS "apiName",
            p.display_name AS "displayName",
            p.base_type    AS "baseType",
            p.is_array     AS "isArray",
            p.is_required  AS "isRequired"
       FROM property p
       JOIN object_type ot ON p.object_type_id = ot.object_type_id
      WHERE ot.api_name = $1 AND p.api_name = $2`,
    [objectTypeApiName, propertyApiName]
  );

  if (result.rows.length === 0) {
    // Check if the object type exists at all
    const otCheck = await query(
      "SELECT 1 FROM object_type WHERE api_name = $1",
      [objectTypeApiName]
    );
    if (otCheck.rows.length === 0) {
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectTypeApiName}' not found.`
      );
    }
    // Object type exists but property does not
    const allProps = await query(
      `SELECT p.api_name
         FROM property p
         JOIN object_type ot ON p.object_type_id = ot.object_type_id
        WHERE ot.api_name = $1
        ORDER BY p.api_name`,
      [objectTypeApiName]
    );
    const validNames = allProps.rows.map((r: any) => r.api_name);
    const systemNames = Object.keys(SYSTEM_FIELDS);
    throw appError(
      "PROPERTY_NOT_FOUND",
      `Property '${propertyApiName}' does not exist on object type '${objectTypeApiName}'. ` +
        `Valid properties: ${[...validNames, ...systemNames].join(", ")}`
    );
  }

  const meta = buildPropertyMeta(result.rows[0]);
  setCache(cacheKey, meta);
  return meta;
}

/**
 * Resolve ALL properties for an object type, returned as a Map.
 */
export async function resolveAllProperties(
  objectTypeApiName: string
): Promise<Map<string, PropertyMeta>> {
  const result = await query(
    `SELECT p.property_id  AS "propertyId",
            p.api_name     AS "apiName",
            p.display_name AS "displayName",
            p.base_type    AS "baseType",
            p.is_array     AS "isArray",
            p.is_required  AS "isRequired"
       FROM property p
       JOIN object_type ot ON p.object_type_id = ot.object_type_id
      WHERE ot.api_name = $1`,
    [objectTypeApiName]
  );

  if (result.rows.length === 0) {
    // Check if the object type exists
    const otCheck = await query(
      "SELECT 1 FROM object_type WHERE api_name = $1",
      [objectTypeApiName]
    );
    if (otCheck.rows.length === 0) {
      const available = await query("SELECT api_name FROM object_type ORDER BY api_name");
      const names = available.rows.map((r: any) => r.api_name);
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectTypeApiName}' not found. Available: ${names.join(", ") || "(none)"}`
      );
    }
    // Object type exists but has no properties — return empty map + system fields
  }

  const map = new Map<string, PropertyMeta>();

  // Add system fields first
  for (const [name, meta] of Object.entries(SYSTEM_FIELDS)) {
    map.set(name, meta);
  }

  // Add user-defined properties
  for (const row of result.rows) {
    const meta = buildPropertyMeta(row);
    map.set(meta.apiName, meta);
    // Also cache individually
    setCache(`${objectTypeApiName}:${meta.apiName}`, meta);
  }

  return map;
}

/**
 * Return the correct OpenSearch field name for a given filter operation.
 */
export async function getOpenSearchFieldForFilter(
  objectTypeApiName: string,
  propertyApiName: string,
  filterType: string
): Promise<string> {
  const meta = await resolveProperty(objectTypeApiName, propertyApiName);
  const effective = getEffectiveBaseType(meta.baseType);

  // Geo types — reject all standard filters
  if (GEO_TYPES.has(effective)) {
    throw appError(
      "INCOMPATIBLE_FILTER",
      "Geo queries require specialized filter types (geoDistance, geoBoundingBox). " +
        "Standard filters are not supported on geo properties."
    );
  }

  // Struct types — reject all filters
  if (effective === "struct") {
    throw appError(
      "INCOMPATIBLE_FILTER",
      "Cannot filter directly on struct properties. Filter on individual struct " +
        "fields using dot notation (e.g., 'address.city')."
    );
  }

  // isNull / isNotNull — always use base field name
  if (NULL_FILTERS.has(filterType)) {
    return meta.opensearchField;
  }

  // contains — full-text search, only for string types
  if (filterType === "contains") {
    if (effective !== "string") {
      throw appError(
        "INCOMPATIBLE_FILTER",
        `Full-text 'contains' filter is only supported on string properties. ` +
          `Property '${propertyApiName}' has type '${meta.baseType}'.`
      );
    }
    return meta.opensearchField; // analyzed text field
  }

  // startsWith — only for string types, uses keyword sub-field
  if (filterType === "startsWith") {
    if (effective !== "string") {
      throw appError(
        "INCOMPATIBLE_FILTER",
        `'startsWith' filter is only supported on string properties. ` +
          `Property '${propertyApiName}' has type '${meta.baseType}'.`
      );
    }
    return meta.opensearchKeywordField;
  }

  // eq, in — exact match
  if (EXACT_FILTERS.has(filterType)) {
    if (effective === "string") {
      return meta.opensearchKeywordField; // .keyword sub-field
    }
    return meta.opensearchField; // direct for all other types
  }

  // gt, gte, lt, lte — range
  if (RANGE_FILTERS.has(filterType)) {
    if (effective === "boolean") {
      throw appError(
        "INCOMPATIBLE_FILTER",
        "Range filters (gt, gte, lt, lte) are not supported on boolean properties. Use 'eq' instead."
      );
    }
    if (effective === "string") {
      return meta.opensearchKeywordField; // lexicographic comparison on keyword
    }
    return meta.opensearchField; // direct for numeric/date
  }

  // Fallback — unknown filter type
  return meta.opensearchField;
}

/**
 * Validate that a property exists on the given object type.
 * Throws PropertyNotFoundError if not.
 */
export async function validatePropertyExists(
  objectTypeApiName: string,
  propertyApiName: string
): Promise<PropertyMeta> {
  return resolveProperty(objectTypeApiName, propertyApiName);
}

// ---------------------------------------------------------------------------
// Self-test (runs when executed directly: npx tsx src/services/propertyResolver.ts)
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string) {
      if (condition) {
        passed++;
        console.log(`  PASS  ${label}`);
      } else {
        failed++;
        console.log(`  FAIL  ${label}`);
      }
    }

    console.log("=== PropertyResolver self-test ===");

    // Test system fields
    const pk = await resolveProperty("AnyType", "__pk");
    assert(pk.baseType === "keyword", "System __pk has baseType keyword");
    assert(pk.supportsExactMatch === true, "System __pk supports exact match");
    assert(pk.supportsGeoQueries === false, "System __pk no geo queries");

    const ot = await resolveProperty("AnyType", "__objectType");
    assert(ot.baseType === "keyword", "System __objectType has baseType keyword");

    const lm = await resolveProperty("AnyType", "__lastModified");
    assert(lm.baseType === "timestamp", "System __lastModified has baseType timestamp");

    const ver = await resolveProperty("AnyType", "__version");
    assert(ver.baseType === "long", "System __version has baseType long");

    // Test buildPropertyMeta
    const strMeta = buildPropertyMeta({
      propertyId: "test",
      apiName: "fullName",
      displayName: "Full Name",
      baseType: "string",
      isArray: false,
      isRequired: false,
    });
    assert(strMeta.opensearchField === "fullName", "string field name is 'fullName'");
    assert(strMeta.opensearchKeywordField === "fullName.keyword", "string keyword field is 'fullName.keyword'");
    assert(strMeta.supportsFullText === true, "string supports full text");
    assert(strMeta.supportsExactMatch === true, "string supports exact match");

    const intMeta = buildPropertyMeta({
      propertyId: "test",
      apiName: "salary",
      displayName: "Salary",
      baseType: "double",
      isArray: false,
      isRequired: false,
    });
    assert(intMeta.supportsFullText === false, "double does not support full text");
    assert(intMeta.opensearchKeywordField === "salary", "double keyword field is just 'salary'");

    const geoMeta = buildPropertyMeta({
      propertyId: "test",
      apiName: "location",
      displayName: "Location",
      baseType: "geopoint",
      isArray: false,
      isRequired: false,
    });
    assert(geoMeta.supportsGeoQueries === true, "geopoint supports geo queries");
    assert(geoMeta.supportsExactMatch === false, "geopoint does not support exact match");

    // Test cache
    invalidateCache();
    assert(cache.size === 0, "Cache cleared");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })();
}
