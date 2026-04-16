// ---------------------------------------------------------------------------
// Property Type to OpenSearch Mapping Engine
//
// Translates Ontology property types (as defined in the PostgreSQL metadata
// store) into OpenSearch field mappings. An incorrect mapping means data is
// stored in a format that cannot be queried correctly — for example, mapping
// a "date" property as "text" would cause date range queries to perform
// lexicographic comparison instead of temporal comparison.
//
// In Palantir's architecture, Object Storage V2 maintains a mapping between
// Ontology property types and the underlying search engine field types. When
// an object type is created or modified, the system generates an index mapping
// and creates (or updates) the corresponding index in the object database.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a property row from the PostgreSQL `property` table. */
export interface PropertyInput {
  api_name: string;
  base_type: string;
  is_array: boolean;
  is_required: boolean;
  struct_schema?: StructSchemaField[] | null;
}

/** A single field within a struct_schema JSONB array. */
export interface StructSchemaField {
  name: string;
  type: string;
}

/** An OpenSearch field mapping object. */
export type OpenSearchFieldMapping = Record<string, unknown>;

// ---------------------------------------------------------------------------
// All supported base types (the 20 types specified in the task)
// ---------------------------------------------------------------------------

const SUPPORTED_TYPES: readonly string[] = [
  "string",
  "boolean",
  "integer",
  "long",
  "double",
  "float",
  "date",
  "timestamp",
  "byte",
  "short",
  "decimal",
  "geopoint",
  "geoshape",
  "string_array",
  "integer_array",
  "double_array",
  "boolean_array",
  "timestamp_array",
  "struct",
] as const;

// ---------------------------------------------------------------------------
// Static mapping table
//
// Each entry is the exact OpenSearch mapping object for the corresponding
// Ontology base type. These must match the specification precisely.
// ---------------------------------------------------------------------------

const STATIC_MAPPINGS: Record<string, OpenSearchFieldMapping> = {
  // String: dual mapping for full-text search + exact match / sorting
  string: {
    type: "text",
    fields: {
      keyword: {
        type: "keyword",
        ignore_above: 256,
      },
    },
  },

  // Boolean: accepts true, false, "true", "false", "" (= false)
  boolean: {
    type: "boolean",
  },

  // Integer: 32-bit signed (-2,147,483,648 to 2,147,483,647)
  integer: {
    type: "integer",
  },

  // Long: 64-bit signed
  long: {
    type: "long",
  },

  // Double: 64-bit IEEE 754 floating point
  double: {
    type: "double",
  },

  // Float: 32-bit IEEE 754 floating point
  float: {
    type: "float",
  },

  // Date: accepts any ISO 8601 date/time literal that Java's
  // strict_date_optional_time parser can digest (including trailing
  // `Z` for UTC), and also plain epoch millis.
  //
  // Historical note: the old custom format
  // `yyyy-MM-dd'T'HH:mm:ss.SSSZ||...` failed on `2023-07-29T22:00:00.000Z`
  // because the trailing `Z` in a Java pattern means "timezone
  // offset" (`+0000`), NOT the literal character `Z`. The canonical
  // fix is to use OpenSearch's built-in `strict_date_optional_time`
  // parser, which handles every ISO 8601 variant the CSV scanner
  // and `typeConverter.ts` emit.
  date: {
    type: "date",
    format: "strict_date_optional_time||epoch_millis",
  },

  // Timestamp: same parser — `strict_date_optional_time` covers the
  // full ISO 8601 grammar including fractional seconds and all
  // timezone forms (`Z`, `+00:00`, `+0000`).
  timestamp: {
    type: "date",
    format: "strict_date_optional_time||epoch_millis",
  },

  // Byte: 8-bit signed (-128 to 127)
  byte: {
    type: "byte",
  },

  // Short: 16-bit signed (-32,768 to 32,767)
  short: {
    type: "short",
  },

  // Decimal: scaled_float preserves precision for financial data
  decimal: {
    type: "scaled_float",
    scaling_factor: 10000,
  },

  // Geopoint: lat/lon pairs for geospatial queries
  geopoint: {
    type: "geo_point",
  },

  // Geoshape: GeoJSON geometries
  geoshape: {
    type: "geo_shape",
  },

  // String array: keyword for exact match on discrete values (tags, skills)
  string_array: {
    type: "keyword",
  },

  // Array types: use the mapping of the base element type
  integer_array: {
    type: "integer",
  },

  double_array: {
    type: "double",
  },

  boolean_array: {
    type: "boolean",
  },

  // Timestamp array: same parser as timestamp.
  timestamp_array: {
    type: "date",
    format: "strict_date_optional_time||epoch_millis",
  },
};

// ---------------------------------------------------------------------------
// Simple type lookup (OpenSearch type name only, no full mapping object)
// ---------------------------------------------------------------------------

const SIMPLE_TYPE_MAP: Record<string, string> = {
  string: "text",
  boolean: "boolean",
  integer: "integer",
  long: "long",
  double: "double",
  float: "float",
  date: "date",
  timestamp: "date",
  byte: "byte",
  short: "short",
  decimal: "scaled_float",
  geopoint: "geo_point",
  geoshape: "geo_shape",
  string_array: "keyword",
  integer_array: "integer",
  double_array: "double",
  boolean_array: "boolean",
  timestamp_array: "date",
  struct: "object",
};

// ---------------------------------------------------------------------------
// mapPropertyToOpenSearch()
// ---------------------------------------------------------------------------

/**
 * Translate an Ontology property (from the PostgreSQL `property` table) into
 * an OpenSearch field mapping object.
 *
 * @param property - A property row with `api_name`, `base_type`, `is_array`,
 *                   `is_required`, and optionally `struct_schema`.
 * @returns The OpenSearch field mapping for this property.
 * @throws Error if the base_type is not supported.
 */
export function mapPropertyToOpenSearch(
  property: PropertyInput
): OpenSearchFieldMapping {
  const { base_type, struct_schema } = property;

  // --- Struct: dynamically generate from struct_schema ---
  if (base_type === "struct") {
    return buildStructMapping(struct_schema ?? null);
  }

  // --- Static mapping lookup ---
  const mapping = STATIC_MAPPINGS[base_type];
  if (mapping) {
    // Return a deep copy to prevent mutation of the static table
    return JSON.parse(JSON.stringify(mapping)) as OpenSearchFieldMapping;
  }

  // --- Unsupported type ---
  throw new Error(
    `Unsupported property base_type: "${base_type}". Supported types: ${SUPPORTED_TYPES.join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// buildStructMapping()
// ---------------------------------------------------------------------------

/**
 * Build an OpenSearch "object" mapping from a struct_schema definition.
 * Each sub-field is mapped recursively via `mapPropertyToOpenSearch`.
 *
 * @param structSchema - Array of `{ name, type }` field definitions, or null.
 * @returns An OpenSearch object mapping with nested properties.
 */
function buildStructMapping(
  structSchema: StructSchemaField[] | null
): OpenSearchFieldMapping {
  const properties: Record<string, OpenSearchFieldMapping> = {};

  if (structSchema && structSchema.length > 0) {
    for (const field of structSchema) {
      // Create a synthetic property input for the sub-field and recurse
      const subProperty: PropertyInput = {
        api_name: field.name,
        base_type: field.type,
        is_array: false,
        is_required: false,
        struct_schema: null,
      };
      properties[field.name] = mapPropertyToOpenSearch(subProperty);
    }
  }

  return {
    type: "object",
    properties,
  };
}

// ---------------------------------------------------------------------------
// getAllSupportedTypes()
// ---------------------------------------------------------------------------

/**
 * Returns an array of all supported base type strings.
 * Used by the validation layer to check that a property's base_type is valid
 * before saving it to PostgreSQL.
 */
export function getAllSupportedTypes(): string[] {
  return [...SUPPORTED_TYPES];
}

// ---------------------------------------------------------------------------
// getOpenSearchTypeForBaseType()
// ---------------------------------------------------------------------------

/**
 * Returns just the OpenSearch type name (e.g., "keyword", "integer", "date")
 * for a given Ontology base type, without the full mapping object.
 * Used for quick lookups.
 *
 * @param baseType - The Ontology base type string.
 * @returns The OpenSearch type name.
 * @throws Error if the base type is not supported.
 */
export function getOpenSearchTypeForBaseType(baseType: string): string {
  const osType = SIMPLE_TYPE_MAP[baseType];
  if (osType) return osType;

  throw new Error(
    `Unsupported property base_type: "${baseType}". Supported types: ${SUPPORTED_TYPES.join(", ")}`
  );
}

// ---------------------------------------------------------------------------
// Inline self-tests (run when executed directly: tsx src/services/mapping/typeMapper.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  function assertDeepEqual(
    actual: unknown,
    expected: unknown,
    label: string
  ): void {
    const a = JSON.stringify(actual, null, 2);
    const e = JSON.stringify(expected, null, 2);
    if (a === e) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
      console.error(`    expected: ${e}`);
      console.error(`    actual:   ${a}`);
    }
  }

  function assertThrows(fn: () => void, expectedSubstring: string, label: string): void {
    try {
      fn();
      failed++;
      console.error(`  FAIL (expected throw): ${label}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(expectedSubstring)) {
        passed++;
      } else {
        failed++;
        console.error(`  FAIL (wrong error message): ${label}`);
        console.error(`    expected to contain: ${expectedSubstring}`);
        console.error(`    actual:              ${msg}`);
      }
    }
  }

  // Helper to build a PropertyInput
  function prop(
    base_type: string,
    struct_schema?: StructSchemaField[] | null
  ): PropertyInput {
    return {
      api_name: "testProp",
      base_type,
      is_array: false,
      is_required: false,
      struct_schema: struct_schema ?? null,
    };
  }

  console.log("Running typeMapper self-tests...\n");

  // -----------------------------------------------------------------------
  // 1. String mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("string")),
    {
      type: "text",
      fields: { keyword: { type: "keyword", ignore_above: 256 } },
    },
    "string -> text with keyword sub-field"
  );

  // -----------------------------------------------------------------------
  // 2. Boolean mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("boolean")),
    { type: "boolean" },
    "boolean -> boolean"
  );

  // -----------------------------------------------------------------------
  // 3. Integer mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("integer")),
    { type: "integer" },
    "integer -> integer"
  );

  // -----------------------------------------------------------------------
  // 4. Long mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("long")),
    { type: "long" },
    "long -> long"
  );

  // -----------------------------------------------------------------------
  // 5. Double mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("double")),
    { type: "double" },
    "double -> double"
  );

  // -----------------------------------------------------------------------
  // 6. Float mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("float")),
    { type: "float" },
    "float -> float"
  );

  // -----------------------------------------------------------------------
  // 7. Date mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("date")),
    {
      type: "date",
      format: "strict_date_optional_time||epoch_millis",
    },
    "date -> strict_date_optional_time"
  );

  // -----------------------------------------------------------------------
  // 8. Timestamp mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("timestamp")),
    {
      type: "date",
      format: "strict_date_optional_time||epoch_millis",
    },
    "timestamp -> strict_date_optional_time"
  );

  // -----------------------------------------------------------------------
  // 9. Byte mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("byte")),
    { type: "byte" },
    "byte -> byte"
  );

  // -----------------------------------------------------------------------
  // 10. Short mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("short")),
    { type: "short" },
    "short -> short"
  );

  // -----------------------------------------------------------------------
  // 11. Decimal mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("decimal")),
    { type: "scaled_float", scaling_factor: 10000 },
    "decimal -> scaled_float with scaling_factor 10000"
  );

  // -----------------------------------------------------------------------
  // 12. Geopoint mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("geopoint")),
    { type: "geo_point" },
    "geopoint -> geo_point"
  );

  // -----------------------------------------------------------------------
  // 13. Geoshape mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("geoshape")),
    { type: "geo_shape" },
    "geoshape -> geo_shape"
  );

  // -----------------------------------------------------------------------
  // 14. String array mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("string_array")),
    { type: "keyword" },
    "string_array -> keyword"
  );

  // -----------------------------------------------------------------------
  // 15. Integer array mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("integer_array")),
    { type: "integer" },
    "integer_array -> integer"
  );

  // -----------------------------------------------------------------------
  // 16. Double array mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("double_array")),
    { type: "double" },
    "double_array -> double"
  );

  // -----------------------------------------------------------------------
  // 17. Boolean array mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("boolean_array")),
    { type: "boolean" },
    "boolean_array -> boolean"
  );

  // -----------------------------------------------------------------------
  // 18. Timestamp array mapping
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("timestamp_array")),
    {
      type: "date",
      format: "strict_date_optional_time||epoch_millis",
    },
    "timestamp_array -> strict_date_optional_time"
  );

  // -----------------------------------------------------------------------
  // 19. Struct mapping (with struct_schema)
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(
      prop("struct", [
        { name: "street", type: "string" },
        { name: "city", type: "string" },
        { name: "zip", type: "string" },
      ])
    ),
    {
      type: "object",
      properties: {
        street: {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        },
        city: {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        },
        zip: {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        },
      },
    },
    "struct with string sub-fields -> object with text+keyword properties"
  );

  // -----------------------------------------------------------------------
  // 20. Struct with mixed sub-field types
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(
      prop("struct", [
        { name: "label", type: "string" },
        { name: "count", type: "integer" },
        { name: "active", type: "boolean" },
        { name: "score", type: "decimal" },
      ])
    ),
    {
      type: "object",
      properties: {
        label: {
          type: "text",
          fields: { keyword: { type: "keyword", ignore_above: 256 } },
        },
        count: { type: "integer" },
        active: { type: "boolean" },
        score: { type: "scaled_float", scaling_factor: 10000 },
      },
    },
    "struct with mixed types -> object with correct nested mappings"
  );

  // -----------------------------------------------------------------------
  // 21. Struct with no schema -> empty object
  // -----------------------------------------------------------------------
  assertDeepEqual(
    mapPropertyToOpenSearch(prop("struct", null)),
    { type: "object", properties: {} },
    "struct with null schema -> object with empty properties"
  );

  assertDeepEqual(
    mapPropertyToOpenSearch(prop("struct", [])),
    { type: "object", properties: {} },
    "struct with empty schema -> object with empty properties"
  );

  // -----------------------------------------------------------------------
  // 22. Unsupported type throws
  // -----------------------------------------------------------------------
  assertThrows(
    () => mapPropertyToOpenSearch(prop("unknown_type")),
    'Unsupported property base_type: "unknown_type"',
    "unknown type throws descriptive error"
  );

  assertThrows(
    () => mapPropertyToOpenSearch(prop("blob")),
    'Unsupported property base_type: "blob"',
    "blob type throws descriptive error"
  );

  // -----------------------------------------------------------------------
  // 23. getAllSupportedTypes()
  // -----------------------------------------------------------------------
  const allTypes = getAllSupportedTypes();
  assert(allTypes.length === 19, `getAllSupportedTypes() returns 19 types (got ${allTypes.length})`);
  assert(allTypes.includes("string"), "includes string");
  assert(allTypes.includes("struct"), "includes struct");
  assert(allTypes.includes("timestamp_array"), "includes timestamp_array");
  assert(!allTypes.includes("blob"), "does not include blob");

  // -----------------------------------------------------------------------
  // 24. getOpenSearchTypeForBaseType()
  // -----------------------------------------------------------------------
  assert(
    getOpenSearchTypeForBaseType("string") === "text",
    "getOpenSearchTypeForBaseType('string') === 'text'"
  );
  assert(
    getOpenSearchTypeForBaseType("integer") === "integer",
    "getOpenSearchTypeForBaseType('integer') === 'integer'"
  );
  assert(
    getOpenSearchTypeForBaseType("date") === "date",
    "getOpenSearchTypeForBaseType('date') === 'date'"
  );
  assert(
    getOpenSearchTypeForBaseType("timestamp") === "date",
    "getOpenSearchTypeForBaseType('timestamp') === 'date'"
  );
  assert(
    getOpenSearchTypeForBaseType("decimal") === "scaled_float",
    "getOpenSearchTypeForBaseType('decimal') === 'scaled_float'"
  );
  assert(
    getOpenSearchTypeForBaseType("geopoint") === "geo_point",
    "getOpenSearchTypeForBaseType('geopoint') === 'geo_point'"
  );
  assert(
    getOpenSearchTypeForBaseType("geoshape") === "geo_shape",
    "getOpenSearchTypeForBaseType('geoshape') === 'geo_shape'"
  );
  assert(
    getOpenSearchTypeForBaseType("string_array") === "keyword",
    "getOpenSearchTypeForBaseType('string_array') === 'keyword'"
  );
  assert(
    getOpenSearchTypeForBaseType("struct") === "object",
    "getOpenSearchTypeForBaseType('struct') === 'object'"
  );

  assertThrows(
    () => getOpenSearchTypeForBaseType("invalid"),
    'Unsupported property base_type: "invalid"',
    "getOpenSearchTypeForBaseType('invalid') throws"
  );

  // -----------------------------------------------------------------------
  // 25. Returned mappings are independent copies (no mutation leakage)
  // -----------------------------------------------------------------------
  const m1 = mapPropertyToOpenSearch(prop("string"));
  const m2 = mapPropertyToOpenSearch(prop("string"));
  (m1 as Record<string, unknown>).type = "MUTATED";
  assert(
    (m2 as Record<string, unknown>).type === "text",
    "returned mappings are independent copies — mutation does not leak"
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll typeMapper tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
