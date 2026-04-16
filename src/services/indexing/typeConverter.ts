// ---------------------------------------------------------------------------
// Type Converter for CSV Values
//
// Converts raw string values from CSV rows into properly typed JavaScript
// values suitable for indexing into OpenSearch. CSV files contain everything
// as strings — this module performs the conversion according to the property
// type definitions in the Ontology schema.
//
// In Palantir's architecture, the Object Data Funnel performs type conversion
// when indexing datasources into Object Storage V2. If a value cannot be
// converted, the row is rejected and an error is logged.
// ---------------------------------------------------------------------------

import { PropertyInput, StructSchemaField } from "../mapping/typeMapper";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Successful conversion result. */
export interface ConvertSuccess {
  value: unknown;
  valid: true;
}

/** Failed conversion result. */
export interface ConvertFailure {
  value: null;
  valid: false;
  error: string;
}

export type ConvertResult = ConvertSuccess | ConvertFailure;

/** Column mapping: CSV column name -> property API name. */
export type ColumnMapping = Record<string, string>;

/** Result of convertRow(). */
export interface ConvertRowResult {
  values: Record<string, unknown>;
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT16_MIN = -32_768;
const INT16_MAX = 32_767;
const INT8_MIN = -128;
const INT8_MAX = 127;

// Currency symbols and codes to strip before numeric parsing
const CURRENCY_RE =
  /^[\$\u20AC\u00A3\u00A5]|^(RWF|USD|EUR|GBP|JPY|KES|UGX|TZS|BIF)\s*/i;

// Month abbreviation lookup (case-insensitive)
const MONTH_ABBREVS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Truthy and falsy string sets for boolean conversion
const TRUTHY = new Set(["true", "1", "yes", "y", "on"]);
const FALSY = new Set(["false", "0", "no", "n", "off"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(value: unknown): ConvertSuccess {
  return { value, valid: true };
}

function fail(error: string): ConvertFailure {
  return { value: null, valid: false, error };
}

/**
 * Strip currency symbols/codes and thousands separators from a numeric string.
 */
function stripNumericFormatting(raw: string): string {
  let s = raw.trim();
  s = s.replace(CURRENCY_RE, "").trim();
  // Strip thousands separators (commas between digits)
  s = s.replace(/,(?=\d{3}(?:\D|$))/g, "");
  return s;
}

/**
 * Check if a date (year, month, day) is a valid calendar date.
 */
function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

/**
 * Format a date as YYYY-MM-DD.
 */
function formatDate(year: number, month: number, day: number): string {
  const yy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Individual type converters
// ---------------------------------------------------------------------------

function convertString(raw: string): ConvertResult {
  return ok(raw.trim());
}

function convertBoolean(raw: string): ConvertResult {
  const lower = raw.trim().toLowerCase();
  if (TRUTHY.has(lower)) return ok(true);
  if (FALSY.has(lower)) return ok(false);
  return fail(
    `Cannot convert '${raw}' to boolean. Expected: true/false, yes/no, 1/0, on/off`
  );
}

function convertInteger(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) return fail(`Cannot convert '${raw}' to integer`);
  if (n < INT32_MIN || n > INT32_MAX) {
    return fail(`Value ${n} is outside the integer range`);
  }
  return ok(n);
}

function convertLong(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) return fail(`Cannot convert '${raw}' to long`);
  // For values exceeding JS safe integer range, return as string
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    // Return the cleaned numeric string for OpenSearch to parse
    return ok(cleaned);
  }
  return ok(n);
}

function convertDouble(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseFloat(cleaned);
  if (isNaN(n) || !isFinite(n)) return fail(`Cannot convert '${raw}' to double`);
  return ok(n);
}

function convertFloat(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseFloat(cleaned);
  if (isNaN(n) || !isFinite(n)) return fail(`Cannot convert '${raw}' to float`);
  // Check approximate 32-bit float range
  if (Math.abs(n) > 3.4e38) {
    return fail(`Value ${n} is outside the float range (approximately ±3.4e38)`);
  }
  return ok(n);
}

function convertByte(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) return fail(`Cannot convert '${raw}' to byte`);
  if (n < INT8_MIN || n > INT8_MAX) {
    return fail(`Value ${n} is outside the byte range (-128 to 127)`);
  }
  return ok(n);
}

function convertShort(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseInt(cleaned, 10);
  if (isNaN(n)) return fail(`Cannot convert '${raw}' to short`);
  if (n < INT16_MIN || n > INT16_MAX) {
    return fail(`Value ${n} is outside the short range (-32768 to 32767)`);
  }
  return ok(n);
}

function convertDecimal(raw: string): ConvertResult {
  const cleaned = stripNumericFormatting(raw);
  const n = parseFloat(cleaned);
  if (isNaN(n) || !isFinite(n)) return fail(`Cannot convert '${raw}' to decimal`);
  return ok(n);
}

function convertDate(raw: string): ConvertResult {
  const s = raw.trim();

  // 1. YYYY-MM-DD (ISO date)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, yy, mm, dd] = isoMatch;
    const y = parseInt(yy, 10);
    const m = parseInt(mm, 10);
    const d = parseInt(dd, 10);
    if (isValidDate(y, m, d)) return ok(formatDate(y, m, d));
    return fail(`Invalid calendar date: '${s}'`);
  }

  // 2/3. MM/DD/YYYY or DD/MM/YYYY — ambiguity resolved below
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, part1, part2, yearStr] = slashMatch;
    const p1 = parseInt(part1, 10);
    const p2 = parseInt(part2, 10);
    const year = parseInt(yearStr, 10);

    // If first number > 12, it must be a day (DD/MM/YYYY)
    if (p1 > 12) {
      const day = p1;
      const month = p2;
      if (isValidDate(year, month, day)) return ok(formatDate(year, month, day));
      return fail(`Invalid calendar date: '${s}'`);
    }

    // If second number > 12, it must be a day → first is month (MM/DD/YYYY)
    if (p2 > 12) {
      const month = p1;
      const day = p2;
      if (isValidDate(year, month, day)) return ok(formatDate(year, month, day));
      return fail(`Invalid calendar date: '${s}'`);
    }

    // Both ≤ 12: PREFER DD/MM/YYYY (Rwandan convention)
    const day = p1;
    const month = p2;
    if (isValidDate(year, month, day)) return ok(formatDate(year, month, day));
    return fail(`Invalid calendar date: '${s}'`);
  }

  // 4. YYYY/MM/DD
  const slashIsoMatch = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIsoMatch) {
    const [, yy, mm, dd] = slashIsoMatch;
    const y = parseInt(yy, 10);
    const m = parseInt(mm, 10);
    const d = parseInt(dd, 10);
    if (isValidDate(y, m, d)) return ok(formatDate(y, m, d));
    return fail(`Invalid calendar date: '${s}'`);
  }

  // 5. DD-Mon-YYYY (e.g., "11-Mar-2025")
  const dMonYMatch = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dMonYMatch) {
    const [, dd, mon, yy] = dMonYMatch;
    const month = MONTH_ABBREVS[mon.toLowerCase()];
    if (month !== undefined) {
      const d = parseInt(dd, 10);
      const y = parseInt(yy, 10);
      if (isValidDate(y, month, d)) return ok(formatDate(y, month, d));
    }
    return fail(`Invalid calendar date: '${s}'`);
  }

  // 6. Mon DD, YYYY (e.g., "Mar 11, 2025")
  const monDYMatch = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s*(\d{4})$/);
  if (monDYMatch) {
    const [, mon, dd, yy] = monDYMatch;
    const month = MONTH_ABBREVS[mon.toLowerCase()];
    if (month !== undefined) {
      const d = parseInt(dd, 10);
      const y = parseInt(yy, 10);
      if (isValidDate(y, month, d)) return ok(formatDate(y, month, d));
    }
    return fail(`Invalid calendar date: '${s}'`);
  }

  return fail(
    `Cannot convert '${raw}' to date. Accepted formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, YYYY/MM/DD, DD-Mon-YYYY, Mon DD YYYY`
  );
}

function convertTimestamp(raw: string): ConvertResult {
  const s = raw.trim();

  // 5. Unix epoch milliseconds (13 digits)
  if (/^\d{13}$/.test(s)) {
    const ms = parseInt(s, 10);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return ok(d.toISOString());
    return fail(`Invalid epoch milliseconds: '${s}'`);
  }

  // 6. Unix epoch seconds (10 digits)
  if (/^\d{10}$/.test(s)) {
    const sec = parseInt(s, 10);
    const d = new Date(sec * 1000);
    if (!isNaN(d.getTime())) return ok(d.toISOString());
    return fail(`Invalid epoch seconds: '${s}'`);
  }

  // 4. "YYYY-MM-DD HH:mm:ss" (space instead of T) — convert to T form
  const spaceTs = s.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, "$1T$2");

  // 1-3. Try parsing as ISO 8601 (handles T variants, Z, +offset, milliseconds)
  const d = new Date(spaceTs);
  if (!isNaN(d.getTime())) {
    return ok(d.toISOString());
  }

  return fail(
    `Cannot convert '${raw}' to timestamp. Accepted formats: ISO 8601, YYYY-MM-DD HH:mm:ss, epoch milliseconds (13 digits), epoch seconds (10 digits)`
  );
}

function convertGeopoint(raw: string): ConvertResult {
  const s = raw.trim();

  // Try JSON parse first (handles both object and array formats)
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);

      // Array format: [lon, lat] (GeoJSON order!)
      if (Array.isArray(parsed)) {
        if (parsed.length !== 2 || typeof parsed[0] !== "number" || typeof parsed[1] !== "number") {
          return fail(`Invalid geopoint array: expected [lon, lat] with two numbers`);
        }
        const lon = parsed[0];
        const lat = parsed[1];
        return validateAndReturnGeopoint(lat, lon, raw);
      }

      // Object format: { lat, lon }
      if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
        return validateAndReturnGeopoint(parsed.lat, parsed.lon, raw);
      }

      return fail(`Invalid geopoint object: expected { lat, lon } with numeric values`);
    } catch {
      return fail(`Cannot parse geopoint JSON: '${raw}'`);
    }
  }

  // Comma-separated string: "lat,lon"
  const parts = s.split(",");
  if (parts.length === 2) {
    const lat = parseFloat(parts[0].trim());
    const lon = parseFloat(parts[1].trim());
    if (!isNaN(lat) && !isNaN(lon)) {
      return validateAndReturnGeopoint(lat, lon, raw);
    }
  }

  return fail(
    `Cannot convert '${raw}' to geopoint. Accepted formats: "lat,lon", {"lat":N,"lon":N}, [lon,lat]`
  );
}

function validateAndReturnGeopoint(
  lat: number,
  lon: number,
  raw: string
): ConvertResult {
  if (lat < -90 || lat > 90) {
    return fail(`Geopoint latitude ${lat} is outside range -90 to 90`);
  }
  if (lon < -180 || lon > 180) {
    return fail(`Geopoint longitude ${lon} is outside range -180 to 180`);
  }
  return ok({ lat, lon });
}

function convertGeoshape(raw: string): ConvertResult {
  const s = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return fail(`Cannot parse geoshape JSON: '${raw}'`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    return fail(`Geoshape must be a JSON object, got ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.type) {
    return fail(`Geoshape must have a 'type' property (Point, Polygon, etc.)`);
  }
  if (!obj.coordinates) {
    return fail(`Geoshape must have a 'coordinates' property`);
  }

  return ok(parsed);
}

// ---------------------------------------------------------------------------
// Array converter
// ---------------------------------------------------------------------------

/**
 * Parse a raw string into an array of strings, then convert each element.
 */
function convertArray(
  raw: string,
  elementType: string,
  apiName: string
): ConvertResult {
  const s = raw.trim();

  // Split into string elements
  let elements: string[];

  // Try JSON parse first
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (!Array.isArray(parsed)) {
        return fail(`Expected JSON array for '${apiName}', got ${typeof parsed}`);
      }
      // Convert all elements to strings for uniform processing
      elements = parsed.map((el: unknown) => String(el));
    } catch {
      // Not valid JSON — fall through to string splitting
      elements = splitArrayString(s);
    }
  } else {
    elements = splitArrayString(s);
  }

  // Convert each element using the base type converter
  const converter = TYPE_CONVERTERS[elementType];
  if (!converter) {
    return fail(`Unsupported array element type: '${elementType}'`);
  }

  const converted: unknown[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i].trim();
    // Skip empty elements in arrays
    if (el === "") continue;

    const result = converter(el);
    if (!result.valid) {
      return fail(
        `Array element at index ${i} ('${el}') cannot be converted to ${elementType}`
      );
    }
    converted.push(result.value);
  }

  return ok(converted);
}

/**
 * Split a string into array elements using pipe > semicolon > comma priority.
 */
function splitArrayString(s: string): string[] {
  if (s.includes("|")) return s.split("|");
  if (s.includes(";")) return s.split(";");
  return s.split(",");
}

// ---------------------------------------------------------------------------
// Struct converter
// ---------------------------------------------------------------------------

function convertStruct(
  raw: string,
  structSchema: StructSchemaField[] | null | undefined
): ConvertResult {
  const s = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return fail(`Cannot parse struct JSON: '${raw}'`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail(`Struct must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // If no schema, return parsed as-is
  if (!structSchema || structSchema.length === 0) {
    return ok(obj);
  }

  // Convert each field according to its schema type
  const result: Record<string, unknown> = {};
  for (const field of structSchema) {
    const rawFieldValue = obj[field.name];

    if (rawFieldValue === undefined || rawFieldValue === null) {
      result[field.name] = null;
      continue;
    }

    // Convert the field value — if it's already the right type, wrap as string
    const strValue = String(rawFieldValue);
    const converter = TYPE_CONVERTERS[field.type];
    if (!converter) {
      return fail(`Unsupported struct field type '${field.type}' for field '${field.name}'`);
    }

    const converted = converter(strValue);
    if (!converted.valid) {
      return fail(`Struct field '${field.name}': ${(converted as ConvertFailure).error}`);
    }
    result[field.name] = converted.value;
  }

  return ok(result);
}

// ---------------------------------------------------------------------------
// Type converter lookup table
// ---------------------------------------------------------------------------

const TYPE_CONVERTERS: Record<string, (raw: string) => ConvertResult> = {
  string: convertString,
  boolean: convertBoolean,
  integer: convertInteger,
  long: convertLong,
  double: convertDouble,
  float: convertFloat,
  byte: convertByte,
  short: convertShort,
  decimal: convertDecimal,
  date: convertDate,
  timestamp: convertTimestamp,
  geopoint: convertGeopoint,
  geoshape: convertGeoshape,
};

// Array type -> base element type
const ARRAY_BASE_TYPES: Record<string, string> = {
  string_array: "string",
  integer_array: "integer",
  double_array: "double",
  boolean_array: "boolean",
  timestamp_array: "timestamp",
};

// ---------------------------------------------------------------------------
// convertValue()
// ---------------------------------------------------------------------------

/**
 * Convert a raw CSV string value into a properly typed JavaScript value
 * suitable for OpenSearch indexing.
 *
 * @param rawValue  - The string value from the CSV (or null/undefined).
 * @param property  - The property definition from PostgreSQL.
 * @returns ConvertResult with the converted value or an error.
 */
export function convertValue(
  rawValue: string | null | undefined,
  property: PropertyInput
): ConvertResult {
  const { api_name, base_type, is_required, struct_schema } = property;

  // --- Null/empty handling ---
  if (
    rawValue === null ||
    rawValue === undefined ||
    rawValue.trim() === ""
  ) {
    if (is_required) {
      return fail(`Required property '${api_name}' has null/empty value`);
    }
    return ok(null);
  }

  // --- Struct type ---
  if (base_type === "struct") {
    return convertStruct(rawValue, struct_schema);
  }

  // --- Array types ---
  const arrayBaseType = ARRAY_BASE_TYPES[base_type];
  if (arrayBaseType) {
    return convertArray(rawValue, arrayBaseType, api_name);
  }

  // --- Scalar types ---
  const converter = TYPE_CONVERTERS[base_type];
  if (!converter) {
    return fail(`Unsupported property type: '${base_type}'`);
  }

  return converter(rawValue);
}

// ---------------------------------------------------------------------------
// convertRow()
// ---------------------------------------------------------------------------

/**
 * Convert an entire CSV row into a typed object with property API names as
 * keys. Uses columnMapping to map CSV column names to property API names.
 *
 * @param row           - The raw CSV row (object with column names as keys).
 * @param properties    - Array of property definitions from PostgreSQL.
 * @param columnMapping - Map of CSV column name -> property API name.
 * @returns A ConvertRowResult with converted values and any errors.
 */
export function convertRow(
  row: Record<string, string>,
  properties: PropertyInput[],
  columnMapping: ColumnMapping
): ConvertRowResult {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  // Invert the column mapping: property api_name -> CSV column name
  const propToColumn: Record<string, string> = {};
  for (const [csvCol, propName] of Object.entries(columnMapping)) {
    propToColumn[propName] = csvCol;
  }

  for (const property of properties) {
    const csvColumnName = propToColumn[property.api_name];

    // If no column mapping exists for this property, treat as null
    const rawValue =
      csvColumnName !== undefined ? row[csvColumnName] ?? null : null;

    const result = convertValue(rawValue, property);

    values[property.api_name] = result.value;

    if (!result.valid) {
      errors.push(`Property ${property.api_name}: ${(result as ConvertFailure).error}`);
    }
  }

  return {
    values,
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { convertValue, convertRow };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/typeConverter.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
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

  function prop(
    base_type: string,
    is_required: boolean = false,
    struct_schema?: StructSchemaField[] | null
  ): PropertyInput {
    return {
      api_name: "testProp",
      base_type,
      is_array: false,
      is_required,
      struct_schema: struct_schema ?? null,
    };
  }

  console.log("Running typeConverter self-tests...\n");

  // =====================================================================
  // Null/empty handling
  // =====================================================================
  {
    const r1 = convertValue(null, prop("string", false));
    assert(r1.valid === true && r1.value === null, "null + optional → null ok");

    const r2 = convertValue(null, prop("string", true));
    assert(r2.valid === false, "null + required → invalid");

    const r3 = convertValue("", prop("integer", false));
    assert(r3.valid === true && r3.value === null, "empty + optional → null ok");

    const r4 = convertValue("", prop("integer", true));
    assert(r4.valid === false, "empty + required → invalid");

    const r5 = convertValue("   ", prop("double", false));
    assert(r5.valid === true && r5.value === null, "whitespace + optional → null ok");

    const r6 = convertValue("   ", prop("double", true));
    assert(r6.valid === false, "whitespace + required → invalid");

    const r7 = convertValue(undefined, prop("string", false));
    assert(r7.valid === true && r7.value === null, "undefined + optional → null ok");
  }

  // =====================================================================
  // String
  // =====================================================================
  {
    const r = convertValue("  Melissa Chang  ", prop("string"));
    assert(r.valid && r.value === "Melissa Chang", "string: trims whitespace");

    const r2 = convertValue("hello", prop("string"));
    assert(r2.valid && r2.value === "hello", "string: simple value");
  }

  // =====================================================================
  // Boolean
  // =====================================================================
  {
    for (const v of ["true", "TRUE", "True", "1", "yes", "YES", "y", "Y", "on", "ON"]) {
      const r = convertValue(v, prop("boolean"));
      assert(r.valid && r.value === true, `boolean: '${v}' → true`);
    }
    for (const v of ["false", "FALSE", "False", "0", "no", "NO", "n", "N", "off", "OFF"]) {
      const r = convertValue(v, prop("boolean"));
      assert(r.valid && r.value === false, `boolean: '${v}' → false`);
    }
    const r = convertValue("maybe", prop("boolean"));
    assert(r.valid === false, "boolean: 'maybe' → invalid");
  }

  // =====================================================================
  // Integer
  // =====================================================================
  {
    const r1 = convertValue("42", prop("integer"));
    assert(r1.valid && r1.value === 42, "integer: '42' → 42");

    const r2 = convertValue("-100", prop("integer"));
    assert(r2.valid && r2.value === -100, "integer: '-100' → -100");

    const r3 = convertValue("1,000,000", prop("integer"));
    assert(r3.valid && r3.value === 1000000, "integer: thousands separator stripped");

    const r4 = convertValue("$1,500", prop("integer"));
    assert(r4.valid && r4.value === 1500, "integer: currency + thousands");

    const r5 = convertValue("RWF 50000", prop("integer"));
    assert(r5.valid && r5.value === 50000, "integer: RWF currency code");

    const r6 = convertValue("abc", prop("integer"));
    assert(r6.valid === false, "integer: 'abc' → invalid");

    const r7 = convertValue("3000000000", prop("integer"));
    assert(r7.valid === false, "integer: out of range → invalid");

    const r8 = convertValue("€1,234", prop("integer"));
    assert(r8.valid && r8.value === 1234, "integer: euro symbol + thousands");
  }

  // =====================================================================
  // Long
  // =====================================================================
  {
    const r1 = convertValue("42", prop("long"));
    assert(r1.valid && r1.value === 42, "long: '42' → 42");

    const r2 = convertValue("9007199254740991", prop("long"));
    assert(r2.valid && r2.value === 9007199254740991, "long: MAX_SAFE_INTEGER");

    const r3 = convertValue("abc", prop("long"));
    assert(r3.valid === false, "long: 'abc' → invalid");
  }

  // =====================================================================
  // Double
  // =====================================================================
  {
    const r1 = convertValue("3.14", prop("double"));
    assert(r1.valid && r1.value === 3.14, "double: '3.14' → 3.14");

    const r2 = convertValue("1.5e6", prop("double"));
    assert(r2.valid && r2.value === 1500000, "double: scientific notation");

    const r3 = convertValue("$1,234.56", prop("double"));
    assert(r3.valid && r3.value === 1234.56, "double: currency + thousands + decimal");

    const r4 = convertValue("abc", prop("double"));
    assert(r4.valid === false, "double: 'abc' → invalid");

    const r5 = convertValue("Infinity", prop("double"));
    assert(r5.valid === false, "double: Infinity → invalid");
  }

  // =====================================================================
  // Float
  // =====================================================================
  {
    const r1 = convertValue("3.14", prop("float"));
    assert(r1.valid && Math.abs((r1.value as number) - 3.14) < 0.001, "float: '3.14'");

    const r2 = convertValue("4e39", prop("float"));
    assert(r2.valid === false, "float: out of range → invalid");
  }

  // =====================================================================
  // Byte
  // =====================================================================
  {
    const r1 = convertValue("127", prop("byte"));
    assert(r1.valid && r1.value === 127, "byte: max 127");

    const r2 = convertValue("-128", prop("byte"));
    assert(r2.valid && r2.value === -128, "byte: min -128");

    const r3 = convertValue("200", prop("byte"));
    assert(r3.valid === false, "byte: 200 out of range");
  }

  // =====================================================================
  // Short
  // =====================================================================
  {
    const r1 = convertValue("32767", prop("short"));
    assert(r1.valid && r1.value === 32767, "short: max 32767");

    const r2 = convertValue("-32768", prop("short"));
    assert(r2.valid && r2.value === -32768, "short: min -32768");

    const r3 = convertValue("40000", prop("short"));
    assert(r3.valid === false, "short: 40000 out of range");
  }

  // =====================================================================
  // Decimal
  // =====================================================================
  {
    const r1 = convertValue("99.1234", prop("decimal"));
    assert(r1.valid && r1.value === 99.1234, "decimal: '99.1234'");

    const r2 = convertValue("$1,234.56", prop("decimal"));
    assert(r2.valid && r2.value === 1234.56, "decimal: currency + thousands");

    const r3 = convertValue("abc", prop("decimal"));
    assert(r3.valid === false, "decimal: 'abc' → invalid");
  }

  // =====================================================================
  // Date
  // =====================================================================
  {
    // ISO
    const r1 = convertValue("2025-03-11", prop("date"));
    assert(r1.valid && r1.value === "2025-03-11", "date: ISO format");

    // US format: 03/11/2025 — second number > 12 would make it US but here
    // both ≤ 12 would default to DD/MM. However 11 could be a day, so with
    // both ≤ 12 we get DD/MM/YYYY = day=3, month=11 = Nov 3
    const r2 = convertValue("03/11/2025", prop("date"));
    assert(r2.valid && r2.value === "2025-11-03", "date: DD/MM ambiguous → DD/MM/YYYY (Rwandan)");

    // Unambiguous US: month = 12, day = 25
    const r2b = convertValue("25/12/2025", prop("date"));
    assert(r2b.valid && r2b.value === "2025-12-25", "date: 25/12/2025 → day=25 (unambiguous DD/MM)");

    // Unambiguous: first > 12 → DD/MM/YYYY
    const r3 = convertValue("15/03/2025", prop("date"));
    assert(r3.valid && r3.value === "2025-03-15", "date: 15/03/2025 → DD/MM (first > 12)");

    // Second > 12 → MM/DD/YYYY
    const r3b = convertValue("03/15/2025", prop("date"));
    assert(r3b.valid && r3b.value === "2025-03-15", "date: 03/15/2025 → MM/DD (second > 12)");

    // YYYY/MM/DD
    const r4 = convertValue("2025/03/11", prop("date"));
    assert(r4.valid && r4.value === "2025-03-11", "date: YYYY/MM/DD");

    // DD-Mon-YYYY
    const r5 = convertValue("11-Mar-2025", prop("date"));
    assert(r5.valid && r5.value === "2025-03-11", "date: DD-Mon-YYYY");

    // Mon DD, YYYY
    const r6 = convertValue("Mar 11, 2025", prop("date"));
    assert(r6.valid && r6.value === "2025-03-11", "date: Mon DD, YYYY");

    // Invalid
    const r7 = convertValue("not-a-date", prop("date"));
    assert(r7.valid === false, "date: invalid → error");

    // Invalid calendar date
    const r8 = convertValue("2025-02-30", prop("date"));
    assert(r8.valid === false, "date: Feb 30 → invalid");
  }

  // =====================================================================
  // Timestamp
  // =====================================================================
  {
    const r1 = convertValue("2025-03-11T10:30:00.000Z", prop("timestamp"));
    assert(r1.valid && r1.value === "2025-03-11T10:30:00.000Z", "timestamp: full ISO");

    const r2 = convertValue("2025-03-11T10:30:00Z", prop("timestamp"));
    assert(r2.valid && r2.value === "2025-03-11T10:30:00.000Z", "timestamp: ISO no ms");

    const r3 = convertValue("2025-03-11T10:30:00", prop("timestamp"));
    assert(r3.valid === true, "timestamp: no timezone → valid");

    const r4 = convertValue("2025-03-11 10:30:00", prop("timestamp"));
    assert(r4.valid === true, "timestamp: space separator → valid");

    // Epoch milliseconds (13 digits)
    const r5 = convertValue("1741651800000", prop("timestamp"));
    assert(r5.valid === true, "timestamp: epoch ms");
    if (r5.valid) {
      assert(typeof r5.value === "string", "timestamp: epoch ms → ISO string");
    }

    // Epoch seconds (10 digits)
    const r6 = convertValue("1741651800", prop("timestamp"));
    assert(r6.valid === true, "timestamp: epoch sec");

    const r7 = convertValue("not-a-timestamp", prop("timestamp"));
    assert(r7.valid === false, "timestamp: invalid → error");
  }

  // =====================================================================
  // Geopoint
  // =====================================================================
  {
    // Comma-separated
    const r1 = convertValue("-1.9403,29.8739", prop("geopoint"));
    assert(r1.valid === true, "geopoint: comma-separated");
    if (r1.valid) {
      const v = r1.value as { lat: number; lon: number };
      assert(v.lat === -1.9403 && v.lon === 29.8739, "geopoint: correct lat/lon");
    }

    // JSON object
    const r2 = convertValue('{"lat":-1.9403,"lon":29.8739}', prop("geopoint"));
    assert(r2.valid === true, "geopoint: JSON object");

    // JSON array [lon, lat]
    const r3 = convertValue("[29.8739,-1.9403]", prop("geopoint"));
    assert(r3.valid === true, "geopoint: JSON array [lon,lat]");
    if (r3.valid) {
      const v = r3.value as { lat: number; lon: number };
      assert(v.lat === -1.9403 && v.lon === 29.8739, "geopoint: array lat/lon correct");
    }

    // Out of range
    const r4 = convertValue("91,0", prop("geopoint"));
    assert(r4.valid === false, "geopoint: lat 91 out of range");

    const r5 = convertValue("0,181", prop("geopoint"));
    assert(r5.valid === false, "geopoint: lon 181 out of range");
  }

  // =====================================================================
  // Geoshape
  // =====================================================================
  {
    const r1 = convertValue(
      '{"type":"Point","coordinates":[29.8739,-1.9403]}',
      prop("geoshape")
    );
    assert(r1.valid === true, "geoshape: valid GeoJSON Point");

    const r2 = convertValue('{"noType":true}', prop("geoshape"));
    assert(r2.valid === false, "geoshape: missing type → invalid");

    const r3 = convertValue('{"type":"Point"}', prop("geoshape"));
    assert(r3.valid === false, "geoshape: missing coordinates → invalid");

    const r4 = convertValue("not json", prop("geoshape"));
    assert(r4.valid === false, "geoshape: not JSON → invalid");
  }

  // =====================================================================
  // Array types
  // =====================================================================
  {
    // string_array: comma-separated
    const r1 = convertValue("python,java,sql", prop("string_array"));
    assert(r1.valid === true, "string_array: comma-separated");
    if (r1.valid) {
      const arr = r1.value as string[];
      assert(arr.length === 3, "string_array: 3 elements");
      assert(arr[0] === "python" && arr[1] === "java" && arr[2] === "sql", "string_array: values");
    }

    // string_array: pipe-separated
    const r2 = convertValue("python|java|sql", prop("string_array"));
    assert(r2.valid === true, "string_array: pipe-separated");
    if (r2.valid) {
      assert((r2.value as string[]).length === 3, "string_array: pipe 3 elements");
    }

    // string_array: semicolon-separated
    const r3 = convertValue("python;java;sql", prop("string_array"));
    assert(r3.valid === true, "string_array: semicolon-separated");

    // string_array: JSON array
    const r4 = convertValue('["python","java","sql"]', prop("string_array"));
    assert(r4.valid === true, "string_array: JSON array");
    if (r4.valid) {
      assert((r4.value as string[]).length === 3, "string_array: JSON 3 elements");
    }

    // integer_array
    const r5 = convertValue("1,2,3", prop("integer_array"));
    assert(r5.valid === true, "integer_array: comma-separated");
    if (r5.valid) {
      const arr = r5.value as number[];
      assert(arr[0] === 1 && arr[1] === 2 && arr[2] === 3, "integer_array: values");
    }

    // integer_array: invalid element
    const r6 = convertValue("1,abc,3", prop("integer_array"));
    assert(r6.valid === false, "integer_array: invalid element → error");
    if (!r6.valid) {
      assert(
        r6.error.includes("index 1"),
        "integer_array: error references index 1"
      );
    }

    // double_array
    const r7 = convertValue("1.1,2.2,3.3", prop("double_array"));
    assert(r7.valid === true, "double_array: comma-separated");

    // boolean_array
    const r8 = convertValue("true,false,yes", prop("boolean_array"));
    assert(r8.valid === true, "boolean_array");
    if (r8.valid) {
      const arr = r8.value as boolean[];
      assert(arr[0] === true && arr[1] === false && arr[2] === true, "boolean_array: values");
    }

    // timestamp_array
    const r9 = convertValue(
      "2025-03-11T10:30:00Z,2025-03-12T10:30:00Z",
      prop("timestamp_array")
    );
    assert(r9.valid === true, "timestamp_array");

    // Empty array from null → null for optional
    const r10 = convertValue(null, prop("string_array", false));
    assert(r10.valid === true && r10.value === null, "string_array: null + optional → null");
  }

  // =====================================================================
  // Struct
  // =====================================================================
  {
    const schema: StructSchemaField[] = [
      { name: "street", type: "string" },
      { name: "zip", type: "integer" },
    ];

    const r1 = convertValue(
      '{"street":"123 Main St","zip":"12345"}',
      prop("struct", false, schema)
    );
    assert(r1.valid === true, "struct: valid JSON");
    if (r1.valid) {
      const v = r1.value as Record<string, unknown>;
      assert(v.street === "123 Main St", "struct: street value");
      assert(v.zip === 12345, "struct: zip converted to integer");
    }

    // Struct: invalid field
    const r2 = convertValue(
      '{"street":"123 Main St","zip":"abc"}',
      prop("struct", false, schema)
    );
    assert(r2.valid === false, "struct: invalid zip → error");

    // Struct: not JSON
    const r3 = convertValue("not json", prop("struct", false, schema));
    assert(r3.valid === false, "struct: not JSON → error");

    // Struct: missing field → null
    const r4 = convertValue('{"street":"123 Main St"}', prop("struct", false, schema));
    assert(r4.valid === true, "struct: missing optional field → null");
    if (r4.valid) {
      assert((r4.value as Record<string, unknown>).zip === null, "struct: missing field is null");
    }
  }

  // =====================================================================
  // convertRow()
  // =====================================================================
  {
    const properties: PropertyInput[] = [
      { api_name: "empId", base_type: "string", is_array: false, is_required: true },
      { api_name: "salary", base_type: "integer", is_array: false, is_required: false },
      { api_name: "active", base_type: "boolean", is_array: false, is_required: false },
    ];

    const columnMapping: ColumnMapping = {
      emp_id: "empId",
      salary_col: "salary",
      is_active: "active",
    };

    const row = {
      emp_id: "EMP-001",
      salary_col: "145000",
      is_active: "true",
    };

    const r1 = convertRow(row, properties, columnMapping);
    assert(r1.valid === true, "convertRow: all valid");
    assert(r1.values.empId === "EMP-001", "convertRow: empId");
    assert(r1.values.salary === 145000, "convertRow: salary");
    assert(r1.values.active === true, "convertRow: active");
    assert(r1.errors.length === 0, "convertRow: no errors");

    // Row with errors
    const row2 = {
      emp_id: "",
      salary_col: "abc",
      is_active: "true",
    };

    const r2 = convertRow(row2, properties, columnMapping);
    assert(r2.valid === false, "convertRow: has errors");
    assert(r2.errors.length === 2, `convertRow: 2 errors (got ${r2.errors.length})`);

    // Row with unmapped property
    const row3 = {
      emp_id: "EMP-003",
      is_active: "false",
    };
    const r3 = convertRow(row3, properties, columnMapping);
    // salary has no column in row3 → treated as null (optional) → valid
    assert(r3.valid === true, "convertRow: unmapped optional column → valid");
    assert(r3.values.salary === null, "convertRow: unmapped column → null");
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll typeConverter tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error("Self-test error:", err);
    /* v8 ignore next */
    process.exit(1);
  });
}
/* v8 ignore stop */
