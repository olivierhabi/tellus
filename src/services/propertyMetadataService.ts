// ---------------------------------------------------------------------------
// Property Metadata Enrichment Service (Task 14)
//
// Enriches raw object data (from OpenSearch) with property metadata from
// PostgreSQL. Used by the Object View endpoints to return properties with
// their displayName, baseType, and description alongside the raw values.
//
// Key responsibilities:
//   - enrichProperties()       — merge raw property values with metadata
//   - getPropertyMetadata()    — cached metadata lookup by object type
//   - formatPropertyValue()    — format values for display (dates, geopoints)
// ---------------------------------------------------------------------------

import { query } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PropertyMetadataEntry {
  apiName: string;
  displayName: string;
  baseType: string;
  description: string | null;
  isRequired: boolean;
  isArray: boolean;
  ordinal: number;
}

export interface EnrichedProperty {
  apiName: string;
  displayName: string;
  baseType: string;
  description: string | null;
  value: unknown;
  formattedValue: string | null;
}

// ---------------------------------------------------------------------------
// In-memory cache with TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  metadata: Map<string, PropertyMetadataEntry>;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const metadataCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// getPropertyMetadata — cached property metadata lookup
// ---------------------------------------------------------------------------

/**
 * Fetch all property metadata for a given object type from PostgreSQL.
 * Results are cached for 60 seconds to avoid repeated DB hits.
 */
export async function getPropertyMetadata(
  objectTypeApiName: string
): Promise<Map<string, PropertyMetadataEntry>> {
  // Check cache
  const cached = metadataCache.get(objectTypeApiName);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.metadata;
  }

  const result = await query(
    `SELECT
       p.api_name,
       p.display_name,
       p.base_type,
       p.description,
       p.is_required,
       p.is_array,
       p.ordinal
     FROM property p
     JOIN object_type ot ON p.object_type_id = ot.object_type_id
     WHERE ot.api_name = $1
     ORDER BY p.ordinal, p.api_name`,
    [objectTypeApiName]
  );

  const metadata = new Map<string, PropertyMetadataEntry>();
  for (const row of result.rows) {
    metadata.set(row.api_name, {
      apiName: row.api_name,
      displayName: row.display_name,
      baseType: row.base_type,
      description: row.description ?? null,
      isRequired: row.is_required,
      isArray: row.is_array,
      ordinal: row.ordinal,
    });
  }

  // Store in cache
  metadataCache.set(objectTypeApiName, {
    metadata,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return metadata;
}

/**
 * Invalidate the metadata cache for a specific object type (or all).
 */
export function invalidateMetadataCache(objectTypeApiName?: string): void {
  if (objectTypeApiName) {
    metadataCache.delete(objectTypeApiName);
  } else {
    metadataCache.clear();
  }
}

// ---------------------------------------------------------------------------
// formatPropertyValue — format raw values for display
// ---------------------------------------------------------------------------

/**
 * Format a raw property value based on its base type for display purposes.
 * Returns a human-friendly string representation.
 */
export function formatPropertyValue(
  value: unknown,
  baseType: string
): string | null {
  if (value === null || value === undefined) return null;

  switch (baseType) {
    case "date": {
      if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
          return d.toISOString().split("T")[0]; // YYYY-MM-DD
        }
      }
      return String(value);
    }

    case "timestamp": {
      if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
          return d.toISOString(); // Full ISO 8601
        }
      }
      return String(value);
    }

    case "geopoint": {
      if (typeof value === "object" && value !== null) {
        const geo = value as Record<string, unknown>;
        if ("lat" in geo && "lon" in geo) {
          return `${geo.lat}, ${geo.lon}`;
        }
      }
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }

    case "geoshape": {
      if (typeof value === "object" && value !== null) {
        const shape = value as Record<string, unknown>;
        if ("type" in shape) {
          return `${shape.type} (GeoJSON)`;
        }
      }
      return JSON.stringify(value);
    }

    case "boolean":
      return value === true ? "true" : "false";

    case "integer":
    case "long":
    case "byte":
    case "short":
      return typeof value === "number" ? Math.floor(value).toString() : String(value);

    case "double":
    case "float":
    case "decimal":
      return typeof value === "number" ? value.toString() : String(value);

    case "struct":
      return typeof value === "object" ? JSON.stringify(value) : String(value);

    case "string_array":
    case "integer_array":
    case "long_array":
    case "double_array":
    case "boolean_array":
    case "timestamp_array":
      if (Array.isArray(value)) {
        return value.map((v) => String(v)).join(", ");
      }
      return String(value);

    case "string":
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// enrichProperties — merge raw object data with property metadata
// ---------------------------------------------------------------------------

/**
 * Enrich raw property values (from OpenSearch) with metadata (from PostgreSQL).
 * Returns an ordered array of EnrichedProperty objects sorted by ordinal.
 */
export async function enrichProperties(
  objectTypeApiName: string,
  rawProperties: Record<string, unknown>
): Promise<EnrichedProperty[]> {
  const metadata = await getPropertyMetadata(objectTypeApiName);
  const result: EnrichedProperty[] = [];

  // Include all known properties, even if missing from raw data
  for (const [apiName, meta] of metadata) {
    const value = rawProperties[apiName] ?? null;
    result.push({
      apiName,
      displayName: meta.displayName,
      baseType: meta.baseType,
      description: meta.description,
      value,
      formattedValue: formatPropertyValue(value, meta.baseType),
    });
  }

  // Sort by ordinal
  const metaArr = [...metadata.values()];
  result.sort((a, b) => {
    const aOrd = metaArr.find((m) => m.apiName === a.apiName)?.ordinal ?? 999;
    const bOrd = metaArr.find((m) => m.apiName === b.apiName)?.ordinal ?? 999;
    return aOrd - bOrd;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Inline self-tests
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS  ${label}`);
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.log(`  FAIL  ${label}`);
    }
  }

  console.log("=== PropertyMetadataService self-test ===\n");

  // ---- formatPropertyValue tests ----

  // string
  assert(
    formatPropertyValue("hello", "string") === "hello",
    "formatPropertyValue: string"
  );

  // null
  assert(
    formatPropertyValue(null, "string") === null,
    "formatPropertyValue: null returns null"
  );

  // undefined
  assert(
    formatPropertyValue(undefined, "integer") === null,
    "formatPropertyValue: undefined returns null"
  );

  // boolean true
  assert(
    formatPropertyValue(true, "boolean") === "true",
    "formatPropertyValue: boolean true"
  );

  // boolean false
  assert(
    formatPropertyValue(false, "boolean") === "false",
    "formatPropertyValue: boolean false"
  );

  // integer
  assert(
    formatPropertyValue(42, "integer") === "42",
    "formatPropertyValue: integer"
  );

  // integer from float
  assert(
    formatPropertyValue(42.7, "integer") === "42",
    "formatPropertyValue: integer truncates"
  );

  // double
  assert(
    formatPropertyValue(3.14, "double") === "3.14",
    "formatPropertyValue: double"
  );

  // date from ISO string
  const dateResult = formatPropertyValue("2025-06-15T10:30:00Z", "date");
  assert(
    dateResult === "2025-06-15",
    `formatPropertyValue: date → ${dateResult}`
  );

  // timestamp from ISO string
  const tsResult = formatPropertyValue("2025-06-15T10:30:00.000Z", "timestamp");
  assert(
    tsResult === "2025-06-15T10:30:00.000Z",
    `formatPropertyValue: timestamp → ${tsResult}`
  );

  // geopoint object
  assert(
    formatPropertyValue({ lat: 40.7128, lon: -74.006 }, "geopoint") === "40.7128, -74.006",
    "formatPropertyValue: geopoint object"
  );

  // geopoint string
  assert(
    formatPropertyValue("40.7128, -74.006", "geopoint") === "40.7128, -74.006",
    "formatPropertyValue: geopoint string"
  );

  // geoshape
  const geoShapeResult = formatPropertyValue(
    { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    "geoshape"
  );
  assert(
    geoShapeResult === "Polygon (GeoJSON)",
    `formatPropertyValue: geoshape → ${geoShapeResult}`
  );

  // struct
  const structResult = formatPropertyValue({ city: "NYC", zip: "10001" }, "struct");
  assert(
    structResult !== null && structResult.includes("city"),
    "formatPropertyValue: struct returns JSON"
  );

  // string_array
  assert(
    formatPropertyValue(["a", "b", "c"], "string_array") === "a, b, c",
    "formatPropertyValue: string_array"
  );

  // integer_array
  assert(
    formatPropertyValue([1, 2, 3], "integer_array") === "1, 2, 3",
    "formatPropertyValue: integer_array"
  );

  // ---- Cache tests (no DB needed) ----

  // invalidateMetadataCache should not throw
  invalidateMetadataCache("NonExistent");
  assert(true, "invalidateMetadataCache: no error for non-existent key");

  invalidateMetadataCache();
  assert(metadataCache.size === 0, "invalidateMetadataCache: all cleared");

  // ---- enrichProperties mock test (without DB) ----
  // Manually populate the cache to test enrichProperties logic
  const mockMetadata = new Map<string, PropertyMetadataEntry>();
  mockMetadata.set("fullName", {
    apiName: "fullName",
    displayName: "Full Name",
    baseType: "string",
    description: "Employee full name",
    isRequired: true,
    isArray: false,
    ordinal: 0,
  });
  mockMetadata.set("salary", {
    apiName: "salary",
    displayName: "Annual Salary",
    baseType: "double",
    description: null,
    isRequired: false,
    isArray: false,
    ordinal: 1,
  });
  mockMetadata.set("active", {
    apiName: "active",
    displayName: "Is Active",
    baseType: "boolean",
    description: "Whether employee is active",
    isRequired: false,
    isArray: false,
    ordinal: 2,
  });

  // Manually set cache
  metadataCache.set("TestEmployee", {
    metadata: mockMetadata,
    expiresAt: Date.now() + 60_000,
  });

  try {
    const enriched = await enrichProperties("TestEmployee", {
      fullName: "John Doe",
      salary: 125000,
      // active is missing — should be null
    });

    assert(enriched.length === 3, "enrichProperties: returns all 3 properties");
    assert(
      enriched[0].apiName === "fullName",
      "enrichProperties: sorted by ordinal (fullName first)"
    );
    assert(
      enriched[0].displayName === "Full Name",
      "enrichProperties: displayName populated"
    );
    assert(
      enriched[0].value === "John Doe",
      "enrichProperties: value populated"
    );
    assert(
      enriched[0].formattedValue === "John Doe",
      "enrichProperties: formattedValue for string"
    );
    assert(
      enriched[1].value === 125000,
      "enrichProperties: salary value correct"
    );
    assert(
      enriched[1].formattedValue === "125000",
      "enrichProperties: salary formatted"
    );
    assert(
      enriched[2].value === null,
      "enrichProperties: missing property is null"
    );
    assert(
      enriched[2].formattedValue === null,
      "enrichProperties: missing property formattedValue is null"
    );
  } catch (err) {
    failed++;
    console.log(`  FAIL  enrichProperties threw: ${err}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
