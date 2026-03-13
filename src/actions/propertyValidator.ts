// ---------------------------------------------------------------------------
// Property Type Validator for Edit Values
//
// Validates property values against an object type's property definitions.
// When an action creates or modifies an object, every property value must
// match the declared type of that property.
//
// This module is SEPARATE from the parameter validator (Task 5):
//   - Parameter validator: checks action INPUT parameters
//   - Property validator: checks RESOLVED property values written to the Ontology
//
// The distinction matters: an action parameter might be a string that maps
// to an integer property via a static rule mapping. The parameter validator
// ensures the input string is valid; this module ensures the resulting
// integer value is valid for the property.
//
// Per Palantir docs on required properties: "Changes via actions are
// validated at apply time: If you attempt to write a null or empty value
// to a property via an action, the action will fail to execute."
//
// This module runs at two points:
//   1. During action execution (Stage 4/6 of the pipeline)
//   2. During indexing from a backing datasource (row transformer)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A property definition row from the database. */
export interface PropertyDefinition {
  api_name: string;
  display_name?: string;
  base_type: string;
  is_required?: boolean;
  is_array?: boolean;
  struct_schema?: StructSchemaField[] | null;
}

/** A single field within a struct_schema JSONB array. */
export interface StructSchemaField {
  name: string;
  type: string;
  required?: boolean;
}

/** Result of property value validation. */
export interface PropertyValidationResult {
  valid: boolean;
  errors: string[];
  coercedValues: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 10_000_000;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const INT8_MIN = -128;
const INT8_MAX = 127;
const SAFE_LONG_MIN = -9007199254740991; // Number.MIN_SAFE_INTEGER
const SAFE_LONG_MAX = 9007199254740991;  // Number.MAX_SAFE_INTEGER
const MAX_STRUCT_DEPTH = 5;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const VALID_GEOSHAPE_TYPES = new Set([
  "Point",
  "LineString",
  "Polygon",
  "MultiPoint",
  "MultiLineString",
  "MultiPolygon",
]);

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Validates a set of property values against an object type's property
 * definitions.
 *
 * @param objectTypeApiName   - The object type being validated against
 * @param propertyValues      - Keys are property apiNames, values to validate
 * @param operation           - 'create' or 'update'
 * @param propertyDefinitions - Property definitions from the database
 * @returns { valid, errors, coercedValues }
 */
export function validatePropertyValues(
  objectTypeApiName: string,
  propertyValues: Record<string, unknown>,
  operation: "create" | "update",
  propertyDefinitions: PropertyDefinition[]
): PropertyValidationResult {
  const errors: string[] = [];
  const coerced: Record<string, unknown> = {};

  // Build lookup map
  const defMap = new Map<string, PropertyDefinition>();
  for (const def of propertyDefinitions) {
    defMap.set(def.api_name, def);
  }

  // -----------------------------------------------------------------
  // 1. Unknown property check
  // -----------------------------------------------------------------
  const validNames = Array.from(defMap.keys());
  for (const key of Object.keys(propertyValues)) {
    if (!defMap.has(key)) {
      errors.push(
        `Unknown property '${key}' on object type '${objectTypeApiName}'. ` +
          `Valid properties are: ${validNames.join(", ")}`
      );
    }
  }

  // Bail early on unknown properties
  if (errors.length > 0) {
    return { valid: false, errors, coercedValues: {} };
  }

  // -----------------------------------------------------------------
  // 2. Required property check (create only)
  // -----------------------------------------------------------------
  if (operation === "create") {
    for (const def of propertyDefinitions) {
      if (def.is_required) {
        const value = propertyValues[def.api_name];
        if (value === undefined || value === null) {
          const displayName = def.display_name || def.api_name;
          errors.push(
            `Required property '${displayName}' (${def.api_name}) must have a value ` +
              `when creating a ${objectTypeApiName} object`
          );
        }
      }
    }
  }

  // For update: check that required properties are not being set to null
  if (operation === "update") {
    for (const [key, value] of Object.entries(propertyValues)) {
      if (value === null) {
        const def = defMap.get(key);
        if (def && def.is_required) {
          errors.push(
            `Cannot set required property '${key}' to null on ${objectTypeApiName}`
          );
        }
      }
    }
  }

  // Bail early on required property errors
  if (errors.length > 0) {
    return { valid: false, errors, coercedValues: {} };
  }

  // -----------------------------------------------------------------
  // 3. Type validation per property
  // -----------------------------------------------------------------
  for (const [key, value] of Object.entries(propertyValues)) {
    const def = defMap.get(key);
    if (!def) continue; // already caught in step 1

    // null is valid for non-required properties (clears the value)
    if (value === null) {
      coerced[key] = null;
      continue;
    }

    // undefined means "don't touch this property" — skip
    if (value === undefined) {
      continue;
    }

    const result = validateSingleValue(
      key,
      value,
      def.base_type,
      objectTypeApiName,
      def.struct_schema ?? null,
      0 // depth
    );

    if (result.error) {
      errors.push(result.error);
    } else {
      coerced[key] = result.value;
    }
  }

  // -----------------------------------------------------------------
  // 4. Return result
  // -----------------------------------------------------------------
  if (errors.length > 0) {
    return { valid: false, errors, coercedValues: {} };
  }

  return { valid: true, errors: [], coercedValues: coerced };
}

// ---------------------------------------------------------------------------
// Single value validator (dispatches by base_type)
// ---------------------------------------------------------------------------

interface SingleValueResult {
  value?: unknown;
  error?: string;
}

function validateSingleValue(
  propName: string,
  value: unknown,
  baseType: string,
  objectType: string,
  structSchema: StructSchemaField[] | null,
  depth: number
): SingleValueResult {
  switch (baseType) {
    case "string":
      return validateString(propName, value);
    case "boolean":
      return validateBoolean(propName, value);
    case "integer":
      return validateInteger(propName, value, INT32_MIN, INT32_MAX);
    case "long":
      return validateInteger(propName, value, SAFE_LONG_MIN, SAFE_LONG_MAX);
    case "byte":
      return validateInteger(propName, value, INT8_MIN, INT8_MAX);
    case "short":
      return validateInteger(propName, value, INT16_MIN, INT16_MAX);
    case "double":
    case "float":
    case "decimal":
      return validateNumber(propName, value);
    case "date":
      return validateDate(propName, value);
    case "timestamp":
      return validateTimestamp(propName, value);
    case "geopoint":
      return validateGeopoint(propName, value);
    case "geoshape":
      return validateGeoshape(propName, value);
    case "struct":
      return validateStruct(propName, value, objectType, structSchema, depth);
    case "string_array":
      return validateTypedArray(propName, value, "string", objectType, depth);
    case "integer_array":
      return validateTypedArray(propName, value, "integer", objectType, depth);
    case "double_array":
      return validateTypedArray(propName, value, "double", objectType, depth);
    case "boolean_array":
      return validateTypedArray(propName, value, "boolean", objectType, depth);
    case "timestamp_array":
      return validateTypedArray(propName, value, "timestamp", objectType, depth);
    default:
      // attachment, marking, media_reference, timeseries — accept as-is for week 1
      return { value };
  }
}

// ---------------------------------------------------------------------------
// Type validators
// ---------------------------------------------------------------------------

function validateString(propName: string, value: unknown): SingleValueResult {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "number") {
    str = String(value);
  } else if (typeof value === "boolean") {
    str = value ? "true" : "false";
  } else {
    return {
      error: `Property '${propName}' must be a string, received: ${typeof value}`,
    };
  }
  if (str.length > MAX_STRING_LENGTH) {
    return {
      error: `Property '${propName}' exceeds maximum string length of ${MAX_STRING_LENGTH} characters`,
    };
  }
  return { value: str };
}

function validateBoolean(propName: string, value: unknown): SingleValueResult {
  if (typeof value === "boolean") return { value };
  if (typeof value === "string") {
    if (value === "true") return { value: true };
    if (value === "false") return { value: false };
  }
  if (typeof value === "number") {
    if (value === 0) return { value: false };
    if (value === 1) return { value: true };
  }
  return {
    error: `Property '${propName}' must be a boolean, received: ${typeof value}`,
  };
}

function validateInteger(
  propName: string,
  value: unknown,
  min: number,
  max: number
): SingleValueResult {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    num = parseInt(value, 10);
  } else {
    return {
      error: `Property '${propName}' must be an integer, received: '${value}'`,
    };
  }
  if (isNaN(num) || !Number.isInteger(num)) {
    return {
      error: `Property '${propName}' must be an integer, received: '${value}'`,
    };
  }
  if (num < min || num > max) {
    return {
      error: `Property '${propName}' must be an integer in range [${min}, ${max}], received: ${num}`,
    };
  }
  return { value: num };
}

function validateNumber(propName: string, value: unknown): SingleValueResult {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    num = parseFloat(value);
  } else {
    return {
      error: `Property '${propName}' must be a number, received: '${value}'`,
    };
  }
  if (isNaN(num) || !isFinite(num)) {
    return {
      error: `Property '${propName}' must be a finite number, received: '${value}'`,
    };
  }
  return { value: num };
}

function validateDate(propName: string, value: unknown): SingleValueResult {
  if (typeof value !== "string") {
    return {
      error: `Property '${propName}' must be a date string in YYYY-MM-DD format, received: '${value}'`,
    };
  }
  if (!DATE_RE.test(value)) {
    return {
      error: `Property '${propName}' must be a date string in YYYY-MM-DD format, received: '${value}'`,
    };
  }
  // Validate the date is real (e.g., reject 2025-02-30)
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return {
      error: `Property '${propName}' must be a valid date in YYYY-MM-DD format, received: '${value}'`,
    };
  }
  return { value };
}

function validateTimestamp(
  propName: string,
  value: unknown
): SingleValueResult {
  // Accept millisecond timestamps (numbers) and coerce to ISO string
  if (typeof value === "number") {
    if (!isFinite(value)) {
      return {
        error: `Property '${propName}' must be a valid ISO 8601 timestamp, received: '${value}'`,
      };
    }
    return { value: new Date(value).toISOString() };
  }

  if (typeof value !== "string") {
    return {
      error: `Property '${propName}' must be a valid ISO 8601 timestamp, received: '${value}'`,
    };
  }

  if (!TIMESTAMP_RE.test(value)) {
    return {
      error: `Property '${propName}' must be a valid ISO 8601 timestamp, received: '${value}'`,
    };
  }

  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return {
      error: `Property '${propName}' must be a valid ISO 8601 timestamp, received: '${value}'`,
    };
  }

  return { value };
}

function validateGeopoint(
  propName: string,
  value: unknown
): SingleValueResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `Property '${propName}' must be an object with { lat, lon } fields`,
    };
  }

  const obj = value as Record<string, unknown>;

  // Accept { lat, lon } or { latitude, longitude }
  let lat: unknown = obj.lat ?? obj.latitude;
  let lon: unknown = obj.lon ?? obj.longitude;

  if (lat === undefined || lon === undefined) {
    return {
      error: `Property '${propName}' must be an object with { lat, lon } fields`,
    };
  }

  // Coerce string to number
  if (typeof lat === "string") lat = parseFloat(lat);
  if (typeof lon === "string") lon = parseFloat(lon);

  if (typeof lat !== "number" || isNaN(lat)) {
    return {
      error: `Property '${propName}' lat must be a number, received: '${obj.lat ?? obj.latitude}'`,
    };
  }
  if (typeof lon !== "number" || isNaN(lon)) {
    return {
      error: `Property '${propName}' lon must be a number, received: '${obj.lon ?? obj.longitude}'`,
    };
  }

  if (lat < -90 || lat > 90) {
    return {
      error: `Property '${propName}' lat must be in range [-90, 90], received: ${lat}`,
    };
  }
  if (lon < -180 || lon > 180) {
    return {
      error: `Property '${propName}' lon must be in range [-180, 180], received: ${lon}`,
    };
  }

  // Normalize to { lat, lon }
  return { value: { lat, lon } };
}

function validateGeoshape(
  propName: string,
  value: unknown
): SingleValueResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `Property '${propName}' must be a GeoJSON object with a 'type' field`,
    };
  }

  const obj = value as Record<string, unknown>;

  if (!obj.type || typeof obj.type !== "string") {
    return {
      error: `Property '${propName}' must have a 'type' field (e.g., "Point", "Polygon")`,
    };
  }

  if (!VALID_GEOSHAPE_TYPES.has(obj.type)) {
    return {
      error: `Property '${propName}' has invalid GeoJSON type '${obj.type}'. ` +
        `Valid types: ${Array.from(VALID_GEOSHAPE_TYPES).join(", ")}`,
    };
  }

  if (!obj.coordinates || !Array.isArray(obj.coordinates)) {
    return {
      error: `Property '${propName}' must have a 'coordinates' array`,
    };
  }

  // Deep coordinate validation is deferred to future iteration
  return { value };
}

function validateStruct(
  propName: string,
  value: unknown,
  objectType: string,
  structSchema: StructSchemaField[] | null,
  depth: number
): SingleValueResult {
  if (depth >= MAX_STRUCT_DEPTH) {
    return {
      error: `Struct nesting exceeds maximum depth of ${MAX_STRUCT_DEPTH} levels for property '${propName}'`,
    };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: `Property '${propName}' must be a plain object (struct), received: ${
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      }`,
    };
  }

  const obj = value as Record<string, unknown>;

  // If no schema defined, accept any object
  if (!structSchema || structSchema.length === 0) {
    return { value: obj };
  }

  // Validate against schema
  const schemaMap = new Map<string, StructSchemaField>();
  for (const field of structSchema) {
    schemaMap.set(field.name, field);
  }

  const coercedStruct: Record<string, unknown> = {};

  // Check required sub-fields
  for (const field of structSchema) {
    if (field.required && (obj[field.name] === undefined || obj[field.name] === null)) {
      return {
        error: `Property '${propName}' struct is missing required field '${field.name}'`,
      };
    }
  }

  // Validate each provided sub-field
  for (const [key, val] of Object.entries(obj)) {
    const fieldDef = schemaMap.get(key);

    if (!fieldDef) {
      // Unknown fields in structs are allowed (pass through)
      coercedStruct[key] = val;
      continue;
    }

    if (val === null || val === undefined) {
      coercedStruct[key] = val;
      continue;
    }

    const fieldResult = validateSingleValue(
      `${propName}.${key}`,
      val,
      fieldDef.type,
      objectType,
      null, // nested structs within a schema don't have their own schema for now
      depth + 1
    );

    if (fieldResult.error) {
      return fieldResult;
    }

    coercedStruct[key] = fieldResult.value;
  }

  return { value: coercedStruct };
}

function validateTypedArray(
  propName: string,
  value: unknown,
  elementType: string,
  objectType: string,
  depth: number
): SingleValueResult {
  if (!Array.isArray(value)) {
    return {
      error: `Property '${propName}' must be an array, received: ${typeof value}`,
    };
  }

  const coerced: unknown[] = [];

  for (let i = 0; i < value.length; i++) {
    const elem = value[i];

    // Null elements are not allowed in arrays
    if (elem === null || elem === undefined) {
      return {
        error: `Property '${propName}' array element at index ${i} must not be null`,
      };
    }

    const elemResult = validateSingleValue(
      `${propName}[${i}]`,
      elem,
      elementType,
      objectType,
      null,
      depth
    );

    if (elemResult.error) {
      return elemResult;
    }

    coerced.push(elemResult.value);
  }

  return { value: coerced };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { validatePropertyValues };
