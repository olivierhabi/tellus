// ---------------------------------------------------------------------------
// Type Coercion Utility (Task 20)
//
// Validates and optionally coerces filter values to match property base types.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_LOOSE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

export function validateAndCoerce(value: unknown, baseType: string): unknown {
  switch (baseType) {
    case "string":
    case "string_array":
      if (typeof value !== "string") throw new Error(`Expected string, got ${typeof value}: ${JSON.stringify(value)}`);
      return value;

    case "boolean":
    case "boolean_array":
      if (typeof value !== "boolean") throw new Error(`Expected boolean (true/false), got ${typeof value}: ${JSON.stringify(value)}`);
      return value;

    case "integer":
    case "integer_array":
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
        throw new Error(`Expected integer, got: ${JSON.stringify(value)}`);
      return value;

    case "long":
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))
        throw new Error(`Expected long (integer), got: ${JSON.stringify(value)}`);
      return value;

    case "double":
    case "double_array":
    case "float":
    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error(`Expected number, got: ${JSON.stringify(value)}`);
      return value;

    case "byte":
      if (typeof value !== "number" || !Number.isInteger(value) || value < -128 || value > 127)
        throw new Error(`Expected byte (-128 to 127), got: ${JSON.stringify(value)}`);
      return value;

    case "short":
      if (typeof value !== "number" || !Number.isInteger(value) || value < -32768 || value > 32767)
        throw new Error(`Expected short (-32768 to 32767), got: ${JSON.stringify(value)}`);
      return value;

    case "date": {
      if (typeof value !== "string") throw new Error(`Expected date string (yyyy-MM-dd), got: ${typeof value}`);
      if (DATE_RE.test(value)) return value;
      if (DATE_LOOSE_RE.test(value)) {
        // Normalize: pad month and day with leading zeros
        const [y, m, d] = value.split("-");
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
      }
      throw new Error(`Expected date in yyyy-MM-dd format, got: '${value}'`);
    }

    case "timestamp":
    case "timestamp_array": {
      if (typeof value !== "string") throw new Error(`Expected timestamp string (ISO 8601), got: ${typeof value}`);
      const d = new Date(value);
      if (isNaN(d.getTime())) throw new Error(`Invalid timestamp: '${value}'`);
      return value;
    }

    case "geopoint": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected geopoint object with lat/lon.");
      const gp = value as any;
      if (typeof gp.lat !== "number" || gp.lat < -90 || gp.lat > 90)
        throw new Error(`Geopoint lat must be -90..90, got: ${gp.lat}`);
      if (typeof gp.lon !== "number" || gp.lon < -180 || gp.lon > 180)
        throw new Error(`Geopoint lon must be -180..180, got: ${gp.lon}`);
      return value;
    }

    case "geoshape": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected GeoJSON object.");
      if (!(value as any).type)
        throw new Error("GeoJSON must have a 'type' field.");
      return value;
    }

    case "struct": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a JSON object for struct type.");
      return value;
    }

    default:
      return value;
  }
}

export function validateArrayValues(values: unknown[], baseType: string): unknown[] {
  return values.map((v, i) => {
    try {
      return validateAndCoerce(v, baseType);
    } catch (err: any) {
      throw new Error(`Array element [${i}]: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string) {
    if (condition) { passed++; console.log(`  PASS  ${label}`); }
    else { failed++; console.log(`  FAIL  ${label}`); }
  }

  function expectThrow(fn: () => void, label: string) {
    try { fn(); failed++; console.log(`  FAIL  ${label} (no throw)`); }
    catch { passed++; console.log(`  PASS  ${label}`); }
  }

  console.log("=== TypeCoercion self-test ===");

  assert(validateAndCoerce("hello", "string") === "hello", "string pass");
  assert(validateAndCoerce(true, "boolean") === true, "boolean pass");
  assert(validateAndCoerce(42, "integer") === 42, "integer pass");
  assert(validateAndCoerce(3.14, "double") === 3.14, "double pass");
  assert(validateAndCoerce(100, "byte") === 100, "byte pass");
  assert(validateAndCoerce("2024-01-15", "date") === "2024-01-15", "date pass");
  assert(validateAndCoerce("2024-1-5", "date") === "2024-01-05", "date coercion");
  assert(validateAndCoerce("2024-01-15T10:30:00Z", "timestamp") === "2024-01-15T10:30:00Z", "timestamp pass");

  expectThrow(() => validateAndCoerce("hello", "integer"), "integer rejects string");
  expectThrow(() => validateAndCoerce(3.5, "integer"), "integer rejects float");
  expectThrow(() => validateAndCoerce("true", "boolean"), "boolean rejects string");
  expectThrow(() => validateAndCoerce(200, "byte"), "byte rejects out of range");
  expectThrow(() => validateAndCoerce("invalid", "date"), "date rejects invalid");

  const arr = validateArrayValues([1, 2, 3], "integer");
  assert(arr.length === 3 && arr[0] === 1, "array validation pass");

  expectThrow(() => validateArrayValues([1, "x", 3], "integer"), "array rejects bad element");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
