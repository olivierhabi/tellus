// ---------------------------------------------------------------------------
// Palantir Type System — all 23 base types
//
// Each type defines:
//   opensearchMapping  – exact JSON for OpenSearch PUT mapping
//   validate(value)    – returns {valid: true} or {valid: false, error: "..."}
//   coerceFromString(raw) – converts a CSV string to the typed JS value
//
// Reference: https://www.palantir.com/docs/foundry/object-link-types/base-types/
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface StructField {
  fieldName: string;
  fieldType: string;
  [key: string]: unknown;
}

export interface TypeDefinition {
  opensearchMapping: Record<string, unknown>;
  validate: (value: unknown, structSchema?: StructField[]) => ValidationResult;
  coerceFromString: (raw: string, structSchema?: StructField[]) => unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
const INT8_MIN = -128;
const INT8_MAX = 127;

function ok(): ValidationResult {
  return { valid: true };
}

function fail(error: string): ValidationResult {
  return { valid: false, error };
}

/**
 * Validate that a string is a real calendar date in YYYY-MM-DD format.
 */
function isValidCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [yearStr, monthStr, dayStr] = s.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  // Month 1-12, day 1-31 basic range
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Use Date to verify the actual calendar date is valid
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

// ---------------------------------------------------------------------------
// TYPE_DEFINITIONS
// ---------------------------------------------------------------------------

export const TYPE_DEFINITIONS: Record<string, TypeDefinition> = {
  // 1. string
  string: {
    opensearchMapping: {
      type: "text",
      fields: { keyword: { type: "keyword", ignore_above: 32766 } },
    },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string") return fail("Expected string or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    },
  },

  // 2. boolean
  boolean: {
    opensearchMapping: { type: "boolean" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "boolean") return fail("Expected boolean or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === "") return null;
      if (["true", "1", "yes"].includes(trimmed)) return true;
      if (["false", "0", "no"].includes(trimmed)) return false;
      throw new Error(`Cannot coerce '${raw}' to boolean`);
    },
  },

  // 3. integer
  integer: {
    opensearchMapping: { type: "integer" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !Number.isInteger(value))
        return fail("Expected integer or null");
      if (value < INT32_MIN || value > INT32_MAX)
        return fail(
          `Integer out of range (${INT32_MIN} to ${INT32_MAX})`
        );
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseInt(trimmed, 10);
      if (isNaN(n)) throw new Error(`Cannot coerce '${raw}' to integer`);
      if (n < INT32_MIN || n > INT32_MAX)
        throw new Error(
          `Integer '${raw}' out of range (${INT32_MIN} to ${INT32_MAX})`
        );
      return n;
    },
  },

  // 4. long
  long: {
    opensearchMapping: { type: "long" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !Number.isInteger(value))
        return fail("Expected long integer or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseInt(trimmed, 10);
      if (isNaN(n)) throw new Error(`Cannot coerce '${raw}' to long`);
      // Warn if value exceeds JS safe integer range
      if (
        Math.abs(n) > Number.MAX_SAFE_INTEGER ||
        (trimmed.replace(/^-/, "").length > 15)
      ) {
        console.warn(
          `Warning: long value '${raw}' may exceed Number.MAX_SAFE_INTEGER. ` +
            `Full BigInt support deferred to future sprint.`
        );
      }
      return n;
    },
  },

  // 5. double
  double: {
    opensearchMapping: { type: "double" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !isFinite(value))
        return fail("Expected finite number or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseFloat(trimmed);
      if (isNaN(n) || !isFinite(n))
        throw new Error(`Cannot coerce '${raw}' to double`);
      return n;
    },
  },

  // 6. float
  float: {
    opensearchMapping: { type: "float" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !isFinite(value))
        return fail("Expected finite number or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseFloat(trimmed);
      if (isNaN(n) || !isFinite(n))
        throw new Error(`Cannot coerce '${raw}' to float`);
      return n;
    },
  },

  // 7. byte
  byte: {
    opensearchMapping: { type: "byte" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !Number.isInteger(value))
        return fail("Expected byte integer or null");
      if (value < INT8_MIN || value > INT8_MAX)
        return fail(`Byte out of range (${INT8_MIN} to ${INT8_MAX})`);
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseInt(trimmed, 10);
      if (isNaN(n)) throw new Error(`Cannot coerce '${raw}' to byte`);
      if (n < INT8_MIN || n > INT8_MAX)
        throw new Error(
          `Byte '${raw}' out of range (${INT8_MIN} to ${INT8_MAX})`
        );
      return n;
    },
  },

  // 8. short
  short: {
    opensearchMapping: { type: "short" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !Number.isInteger(value))
        return fail("Expected short integer or null");
      if (value < INT16_MIN || value > INT16_MAX)
        return fail(
          `Short out of range (${INT16_MIN} to ${INT16_MAX})`
        );
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseInt(trimmed, 10);
      if (isNaN(n)) throw new Error(`Cannot coerce '${raw}' to short`);
      if (n < INT16_MIN || n > INT16_MAX)
        throw new Error(
          `Short '${raw}' out of range (${INT16_MIN} to ${INT16_MAX})`
        );
      return n;
    },
  },

  // 9. decimal (maps to double in OpenSearch)
  decimal: {
    opensearchMapping: { type: "double" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "number" || !isFinite(value))
        return fail("Expected finite number or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = parseFloat(trimmed);
      if (isNaN(n) || !isFinite(n))
        throw new Error(`Cannot coerce '${raw}' to decimal`);
      return n;
    },
  },

  // 10. date
  date: {
    opensearchMapping: { type: "date", format: "yyyy-MM-dd" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string") return fail("Expected date string or null");
      if (!isValidCalendarDate(value))
        return fail(`Invalid calendar date: '${value}'`);
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      if (!isValidCalendarDate(trimmed))
        throw new Error(`Invalid calendar date: '${trimmed}'`);
      return trimmed;
    },
  },

  // 11. timestamp
  timestamp: {
    opensearchMapping: { type: "date" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string")
        return fail("Expected ISO 8601 timestamp string or null");
      const d = new Date(value);
      if (isNaN(d.getTime())) return fail(`Invalid timestamp: '${value}'`);
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const d = new Date(trimmed);
      if (isNaN(d.getTime()))
        throw new Error(`Cannot coerce '${raw}' to timestamp`);
      return d.toISOString();
    },
  },

  // 12. geopoint
  geopoint: {
    opensearchMapping: { type: "geo_point" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "object" || value === null)
        return fail("Expected {lat, lon} object or null");
      const v = value as Record<string, unknown>;
      if (typeof v.lat !== "number" || typeof v.lon !== "number")
        return fail("geopoint must have numeric lat and lon");
      if (v.lat < -90 || v.lat > 90)
        return fail("lat must be between -90 and 90");
      if (v.lon < -180 || v.lon > 180)
        return fail("lon must be between -180 and 180");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const parts = trimmed.split(",");
      if (parts.length !== 2)
        throw new Error(
          `Cannot coerce '${raw}' to geopoint — expected 'lat,lon'`
        );
      const lat = parseFloat(parts[0].trim());
      const lon = parseFloat(parts[1].trim());
      if (isNaN(lat) || isNaN(lon))
        throw new Error(`Cannot coerce '${raw}' to geopoint — non-numeric`);
      if (lat < -90 || lat > 90)
        throw new Error(`lat ${lat} out of range (-90 to 90)`);
      if (lon < -180 || lon > 180)
        throw new Error(`lon ${lon} out of range (-180 to 180)`);
      return { lat, lon };
    },
  },

  // 13. geoshape
  geoshape: {
    opensearchMapping: { type: "geo_shape" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "object" || value === null)
        return fail("Expected GeoJSON object or null");
      const v = value as Record<string, unknown>;
      if (!v.type) return fail("GeoJSON must have a 'type' property");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`Cannot coerce '${raw}' to geoshape — invalid JSON`);
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !(parsed as Record<string, unknown>).type
      )
        throw new Error(`geoshape JSON must have a 'type' property`);
      return parsed;
    },
  },

  // 14. struct
  struct: {
    opensearchMapping: { type: "object", properties: {} },
    validate(value: unknown, structSchema?: StructField[]): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "object" || value === null)
        return fail("Expected object or null for struct");
      if (structSchema) {
        const v = value as Record<string, unknown>;
        for (const field of structSchema) {
          const fieldVal = v[field.fieldName];
          if (fieldVal !== undefined && fieldVal !== null) {
            const fieldDef = TYPE_DEFINITIONS[field.fieldType];
            if (fieldDef) {
              const res = fieldDef.validate(fieldVal);
              if (!res.valid)
                return fail(
                  `struct field '${field.fieldName}': ${res.error}`
                );
            }
          }
        }
      }
      return ok();
    },
    coerceFromString(raw: string, structSchema?: StructField[]): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`Cannot coerce '${raw}' to struct — invalid JSON`);
      }
      if (typeof parsed !== "object" || parsed === null)
        throw new Error(`struct value must be a JSON object`);
      if (structSchema) {
        const obj = parsed as Record<string, unknown>;
        for (const field of structSchema) {
          const fieldVal = obj[field.fieldName];
          if (fieldVal !== undefined && fieldVal !== null) {
            const fieldDef = TYPE_DEFINITIONS[field.fieldType];
            if (fieldDef) {
              const res = fieldDef.validate(fieldVal);
              if (!res.valid)
                throw new Error(
                  `struct field '${field.fieldName}': ${res.error}`
                );
            }
          }
        }
      }
      return parsed;
    },
  },

  // 15. string_array
  string_array: {
    opensearchMapping: { type: "keyword" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (!Array.isArray(value)) return fail("Expected array or null");
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string")
          return fail(`Element [${i}] is not a string`);
      }
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      return trimmed.split("|").map((s) => s.trim());
    },
  },

  // 16. integer_array
  integer_array: {
    opensearchMapping: { type: "integer" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (!Array.isArray(value)) return fail("Expected array or null");
      for (let i = 0; i < value.length; i++) {
        const res = TYPE_DEFINITIONS.integer.validate(value[i]);
        if (!res.valid) return fail(`Element [${i}]: ${res.error}`);
      }
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      return trimmed
        .split("|")
        .map((s) => TYPE_DEFINITIONS.integer.coerceFromString(s));
    },
  },

  // 17. double_array
  double_array: {
    opensearchMapping: { type: "double" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (!Array.isArray(value)) return fail("Expected array or null");
      for (let i = 0; i < value.length; i++) {
        const res = TYPE_DEFINITIONS.double.validate(value[i]);
        if (!res.valid) return fail(`Element [${i}]: ${res.error}`);
      }
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      return trimmed
        .split("|")
        .map((s) => TYPE_DEFINITIONS.double.coerceFromString(s));
    },
  },

  // 18. boolean_array
  boolean_array: {
    opensearchMapping: { type: "boolean" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (!Array.isArray(value)) return fail("Expected array or null");
      for (let i = 0; i < value.length; i++) {
        const res = TYPE_DEFINITIONS.boolean.validate(value[i]);
        if (!res.valid) return fail(`Element [${i}]: ${res.error}`);
      }
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      return trimmed
        .split("|")
        .map((s) => TYPE_DEFINITIONS.boolean.coerceFromString(s));
    },
  },

  // 19. timestamp_array
  timestamp_array: {
    opensearchMapping: { type: "date" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (!Array.isArray(value)) return fail("Expected array or null");
      for (let i = 0; i < value.length; i++) {
        const res = TYPE_DEFINITIONS.timestamp.validate(value[i]);
        if (!res.valid) return fail(`Element [${i}]: ${res.error}`);
      }
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      return trimmed
        .split("|")
        .map((s) => TYPE_DEFINITIONS.timestamp.coerceFromString(s));
    },
  },

  // 20. attachment
  attachment: {
    opensearchMapping: { type: "keyword" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string")
        return fail("Expected string (attachment RID/path) or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    },
  },

  // 21. marking
  marking: {
    opensearchMapping: { type: "keyword" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string") return fail("Expected string or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed.toUpperCase();
    },
  },

  // 22. media_reference
  media_reference: {
    opensearchMapping: { type: "object", enabled: false },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "object")
        return fail("Expected object or null for media_reference");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error(
          `Cannot coerce '${raw}' to media_reference — invalid JSON`
        );
      }
    },
  },

  // 23. timeseries
  timeseries: {
    opensearchMapping: { type: "keyword" },
    validate(value: unknown): ValidationResult {
      if (value === null || value === undefined) return ok();
      if (typeof value !== "string")
        return fail("Expected string (timeseries reference) or null");
      return ok();
    },
    coerceFromString(raw: string): unknown {
      const trimmed = raw.trim();
      return trimmed === "" ? null : trimmed;
    },
  },
};

// ---------------------------------------------------------------------------
// Exported constants and helpers
// ---------------------------------------------------------------------------

/** All 23 valid base type names. */
export const VALID_BASE_TYPES: string[] = Object.keys(TYPE_DEFINITIONS);

/**
 * Get the OpenSearch mapping for a given base type.
 * For 'struct', optionally uses structSchema to build nested property mappings.
 */
export function getOpenSearchMapping(
  baseType: string,
  structSchema?: StructField[]
): Record<string, unknown> {
  const def = TYPE_DEFINITIONS[baseType];
  if (!def) throw new Error(`Unknown base type: '${baseType}'`);

  if (baseType === "struct" && structSchema && structSchema.length > 0) {
    const properties: Record<string, unknown> = {};
    for (const field of structSchema) {
      const fieldDef = TYPE_DEFINITIONS[field.fieldType];
      if (fieldDef) {
        properties[field.fieldName] = fieldDef.opensearchMapping;
      }
    }
    return { type: "object", properties };
  }

  return { ...def.opensearchMapping };
}

/**
 * Validate a value against a base type.
 */
export function validateValue(
  baseType: string,
  value: unknown,
  structSchema?: StructField[]
): ValidationResult {
  const def = TYPE_DEFINITIONS[baseType];
  if (!def) return fail(`Unknown base type: '${baseType}'`);
  return def.validate(value, structSchema);
}

/**
 * Coerce a raw CSV string to the typed JavaScript value for the given base type.
 * Throws an Error with a descriptive message if coercion fails.
 */
export function coerceFromString(
  baseType: string,
  raw: string,
  structSchema?: StructField[]
): unknown {
  const def = TYPE_DEFINITIONS[baseType];
  if (!def) throw new Error(`Unknown base type: '${baseType}'`);
  return def.coerceFromString(raw, structSchema);
}

/**
 * Returns true if the base type is an array type (ends with '_array').
 */
export function isArrayType(baseType: string): boolean {
  return baseType.endsWith("_array");
}

/**
 * Returns the scalar base type for an array type.
 * e.g., 'string_array' -> 'string', 'integer_array' -> 'integer'.
 * Throws if the given type is not an array type.
 */
export function getBaseTypeOfArray(baseType: string): string {
  if (!isArrayType(baseType))
    throw new Error(`'${baseType}' is not an array type`);
  return baseType.replace(/_array$/, "");
}

// ---------------------------------------------------------------------------
// Inline self-tests (run when executed directly: tsx src/utils/typeSystem.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  function assertThrows(fn: () => void, label: string): void {
    try {
      fn();
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL (expected throw): ${label}`);
    } catch {
      passed++;
    }
  }

  console.log("Running type system self-tests...\n");

  // 1. VALID_BASE_TYPES has exactly 23 entries
  assert(
    VALID_BASE_TYPES.length === 23,
    `VALID_BASE_TYPES has ${VALID_BASE_TYPES.length} entries (expected 23)`
  );

  // 2. coerceFromString('integer', '42') -> 42
  assert(
    coerceFromString("integer", "42") === 42,
    "coerceFromString('integer', '42') === 42"
  );

  // 3. coerceFromString('date', '2025-02-30') -> throws (invalid calendar date)
  assertThrows(
    () => coerceFromString("date", "2025-02-30"),
    "coerceFromString('date', '2025-02-30') throws"
  );

  // 4. coerceFromString('geopoint', '-1.94,29.87') -> {lat: -1.94, lon: 29.87}
  const gp = coerceFromString("geopoint", "-1.94,29.87") as {
    lat: number;
    lon: number;
  };
  assert(
    gp.lat === -1.94 && gp.lon === 29.87,
    "coerceFromString('geopoint', '-1.94,29.87') -> {lat: -1.94, lon: 29.87}"
  );

  // 5. coerceFromString('boolean', 'true') -> true
  assert(
    coerceFromString("boolean", "true") === true,
    "coerceFromString('boolean', 'true') === true"
  );

  // 6. isArrayType('string_array') -> true
  assert(
    isArrayType("string_array") === true,
    "isArrayType('string_array') === true"
  );

  // 7. getBaseTypeOfArray('string_array') -> 'string'
  assert(
    getBaseTypeOfArray("string_array") === "string",
    "getBaseTypeOfArray('string_array') === 'string'"
  );

  // Additional coverage tests
  assert(
    coerceFromString("boolean", "FALSE") === false,
    "coerceFromString('boolean', 'FALSE') === false"
  );
  assert(
    coerceFromString("boolean", "1") === true,
    "coerceFromString('boolean', '1') === true"
  );
  assert(
    coerceFromString("boolean", "0") === false,
    "coerceFromString('boolean', '0') === false"
  );
  assert(
    coerceFromString("boolean", "yes") === true,
    "coerceFromString('boolean', 'yes') === true"
  );
  assert(
    coerceFromString("boolean", "no") === false,
    "coerceFromString('boolean', 'no') === false"
  );
  assert(
    coerceFromString("string", "") === null,
    "coerceFromString('string', '') === null"
  );
  assert(
    coerceFromString("integer", "") === null,
    "coerceFromString('integer', '') === null"
  );
  assert(
    coerceFromString("date", "2025-03-11") === "2025-03-11",
    "coerceFromString('date', '2025-03-11') === '2025-03-11'"
  );
  assertThrows(
    () => coerceFromString("date", "2025-13-01"),
    "coerceFromString('date', '2025-13-01') throws"
  );
  assertThrows(
    () => coerceFromString("boolean", "maybe"),
    "coerceFromString('boolean', 'maybe') throws"
  );
  assert(
    coerceFromString("marking", " secret ") === "SECRET",
    "coerceFromString('marking', ' secret ') === 'SECRET'"
  );
  assert(
    isArrayType("string") === false,
    "isArrayType('string') === false"
  );
  assertThrows(
    () => getBaseTypeOfArray("string"),
    "getBaseTypeOfArray('string') throws"
  );
  assert(
    getBaseTypeOfArray("double_array") === "double",
    "getBaseTypeOfArray('double_array') === 'double'"
  );

  // Validate every type has all three methods
  for (const typeName of VALID_BASE_TYPES) {
    const def = TYPE_DEFINITIONS[typeName];
    assert(
      def.opensearchMapping !== undefined,
      `${typeName} has opensearchMapping`
    );
    assert(
      typeof def.validate === "function",
      `${typeName} has validate()`
    );
    assert(
      typeof def.coerceFromString === "function",
      `${typeName} has coerceFromString()`
    );
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll type system tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

// Run self-tests when executed directly
/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
