// ---------------------------------------------------------------------------
// Parameter Validation Engine
//
// Validates action parameters against the action type's parameter schema.
// Used in Stage 1 of the action execution pipeline — before any edits are
// applied, every parameter provided by the caller must pass validation.
//
// Palantir documents "Invalid parameter failure" as a specific failure type
// tracked in action metrics. This module produces clear, specific error
// messages that tell the caller exactly which parameter failed and why.
//
// Validation pipeline (executed in order):
//   Step 1: Check for unknown parameters
//   Step 2: Check required parameters
//   Step 3: Apply default values
//   Step 4: Type validation and coercion
//   Step 5: Constraint validation
//   Step 6: Return result
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single parameter definition from action_type.parameters. */
export interface ParameterDefinition {
  apiName: string;
  displayName: string;
  type: string;
  required?: boolean;
  objectType?: string;
  /** Required for interface_reference and interface_reference_array. */
  interfaceId?: string;
  defaultValue?: unknown;
  constraints?: ParameterConstraints;
}

/** Constraint rules for a parameter. */
export interface ParameterConstraints {
  regex?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  allowedValues?: string[];
  minItems?: number;
  maxItems?: number;
}

/** Async function to check if an object exists in the Ontology. */
export type ObjectExistsChecker = (
  objectType: string,
  primaryKey: string
) => Promise<boolean>;

/** Result of parameter validation. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  resolvedParameters: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum string length (Palantir allows very long strings for text fields). */
const MAX_STRING_LENGTH = 10_000_000;

/** 32-bit signed integer range (matching Java int). */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** 64-bit signed long range. */
const LONG_MIN = BigInt("-9223372036854775808");
const LONG_MAX = BigInt("9223372036854775807");

/** ISO 8601 date pattern: YYYY-MM-DD. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 8601 timestamp pattern (basic check — full parsing via Date). */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Validates action parameters against the action type's parameter schema.
 *
 * @param parameterDefinitions - The parameter schema from action_type.parameters
 * @param providedParameters   - The parameters provided by the caller
 * @param objectExistsChecker  - Async function to check object existence
 * @returns Validation result with errors and resolved/coerced parameters
 */
export async function validateParameters(
  parameterDefinitions: ParameterDefinition[],
  providedParameters: Record<string, unknown>,
  objectExistsChecker: ObjectExistsChecker
): Promise<ValidationResult> {
  const errors: string[] = [];
  const resolved: Record<string, unknown> = {};

  // Build lookup map of parameter definitions
  const defMap = new Map<string, ParameterDefinition>();
  for (const def of parameterDefinitions) {
    defMap.set(def.apiName, def);
  }

  // -----------------------------------------------------------------------
  // Step 1: Check for unknown parameters
  // -----------------------------------------------------------------------
  const validNames = Array.from(defMap.keys());
  for (const key of Object.keys(providedParameters)) {
    if (!defMap.has(key)) {
      errors.push(
        `Unknown parameter '${key}'. Valid parameters are: ${validNames.join(", ")}`
      );
    }
  }

  // If there are unknown parameters, bail early — they might cause confusing
  // downstream errors if we try to validate them.
  if (errors.length > 0) {
    return { valid: false, errors, resolvedParameters: null };
  }

  // -----------------------------------------------------------------------
  // Step 2: Check required parameters
  // -----------------------------------------------------------------------
  for (const def of parameterDefinitions) {
    if (def.required === true) {
      const value = providedParameters[def.apiName];
      if (value === undefined || value === null) {
        errors.push(
          `Required parameter '${def.apiName}' (${def.displayName}) is missing`
        );
      }
    }
  }

  // If required parameters are missing, bail early — no point validating
  // types of values that don't exist.
  if (errors.length > 0) {
    return { valid: false, errors, resolvedParameters: null };
  }

  // -----------------------------------------------------------------------
  // Step 3: Apply default values
  // -----------------------------------------------------------------------
  for (const def of parameterDefinitions) {
    const provided = providedParameters[def.apiName];
    if (provided !== undefined && provided !== null) {
      resolved[def.apiName] = provided;
    } else if (def.required !== true && (provided === undefined || provided === null)) {
      // Non-required, not provided or null
      if (provided === null) {
        // Explicitly set to null — keep as null
        resolved[def.apiName] = null;
      } else if (def.defaultValue !== undefined) {
        // Apply default value
        resolved[def.apiName] = def.defaultValue;
      }
      // else: not provided at all, no default — leave as undefined (omit)
    } else {
      // Required parameter — already verified as present in step 2
      resolved[def.apiName] = provided;
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Type validation and coercion
  // -----------------------------------------------------------------------
  for (const def of parameterDefinitions) {
    const value = resolved[def.apiName];

    // Skip undefined (not provided, no default) and null (explicitly null
    // for non-required params)
    if (value === undefined || value === null) {
      continue;
    }

    const coerced = await validateAndCoerceType(
      def,
      value,
      objectExistsChecker,
      errors
    );

    if (coerced !== undefined) {
      resolved[def.apiName] = coerced;
    }
    // If coerced is undefined, an error was already added; keep the
    // original value for potential constraint checking but it won't
    // matter because we'll return invalid.
  }

  // If type errors occurred, bail before constraint validation
  if (errors.length > 0) {
    return { valid: false, errors, resolvedParameters: null };
  }

  // -----------------------------------------------------------------------
  // Step 5: Constraint validation
  // -----------------------------------------------------------------------
  for (const def of parameterDefinitions) {
    if (!def.constraints) continue;

    const value = resolved[def.apiName];
    if (value === undefined || value === null) continue;

    validateConstraints(def, value, errors);
  }

  // -----------------------------------------------------------------------
  // Step 6: Return result
  // -----------------------------------------------------------------------
  if (errors.length > 0) {
    return { valid: false, errors, resolvedParameters: null };
  }

  return { valid: true, errors: [], resolvedParameters: resolved };
}

// ---------------------------------------------------------------------------
// Step 4 helpers: Type validation and coercion
// ---------------------------------------------------------------------------

/**
 * Validate and coerce a single parameter value. Returns the coerced value,
 * or undefined if validation failed (error added to errors array).
 */
async function validateAndCoerceType(
  def: ParameterDefinition,
  value: unknown,
  objectExistsChecker: ObjectExistsChecker,
  errors: string[]
): Promise<unknown | undefined> {
  const { apiName, type: paramType } = def;

  switch (paramType) {
    case "string":
      return coerceString(apiName, value, errors);

    case "boolean":
      return coerceBoolean(apiName, value, errors);

    case "integer":
      return coerceInteger(apiName, value, errors);

    case "byte":
      return coerceBoundedInteger(apiName, value, -128, 127, "byte", errors);

    case "short":
      return coerceBoundedInteger(apiName, value, -32768, 32767, "short", errors);

    case "long":
      return coerceLong(apiName, value, errors);

    case "double":
    case "float":
    case "decimal":
      return coerceDouble(apiName, value, paramType, errors);

    case "date":
      return coerceDate(apiName, value, errors);

    case "timestamp":
      return coerceTimestamp(apiName, value, errors);

    case "object_reference":
      return coerceObjectReference(apiName, value, def, objectExistsChecker, errors);

    case "object_type_reference":
      if (typeof value !== "string" || value.length === 0) {
        errors.push(
          `Parameter '${apiName}' must be the API name of an object type implementing interface '${def.interfaceId ?? ""}'.`,
        );
        return undefined;
      }
      return value;

    case "interface_reference":
      return coerceInterfaceReference(apiName, value, def, objectExistsChecker, errors);

    case "interface_reference_array":
      return coerceInterfaceReferenceArray(apiName, value, def, objectExistsChecker, errors);

    case "object_set":
      return coerceObjectSet(apiName, value, errors);

    case "string_array":
      return coerceTypedArray(apiName, value, "string", errors);

    case "integer_array":
      return coerceTypedArray(apiName, value, "integer", errors);

    case "double_array":
      return coerceTypedArray(apiName, value, "double", errors);

    case "boolean_array":
      return coerceTypedArray(apiName, value, "boolean", errors);

    case "timestamp_array":
      return coerceTypedArray(apiName, value, "timestamp", errors);

    case "geopoint":
      return coerceGeopoint(apiName, value, errors);

    case "geoshape":
      return coerceGeoshape(apiName, value, errors);

    case "struct":
      return coerceStruct(apiName, value, errors);

    case "attachment":
    case "marking":
    case "media_reference":
    case "timeseries":
      return value;

    default:
      errors.push(
        `Parameter '${apiName}' has unsupported type '${paramType}'.`
      );
      return undefined;
  }
}

export interface ResolvedInterfaceReference {
  objectType: string;
  primaryKey: string;
}

async function coerceInterfaceReference(
  apiName: string,
  value: unknown,
  def: ParameterDefinition,
  objectExistsChecker: ObjectExistsChecker,
  errors: string[],
): Promise<ResolvedInterfaceReference | undefined> {
  if (!def.interfaceId) {
    errors.push(
      `Parameter '${apiName}' is type 'interface_reference' but has no interfaceId configured.`,
    );
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      `Parameter '${apiName}' must be an interface reference object with objectType and primaryKey.`,
    );
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.objectType !== "string" ||
    candidate.objectType.length === 0 ||
    typeof candidate.primaryKey !== "string" ||
    candidate.primaryKey.length === 0
  ) {
    errors.push(
      `Parameter '${apiName}' must contain non-empty string objectType and primaryKey fields.`,
    );
    return undefined;
  }
  if (!(await objectExistsChecker(candidate.objectType, candidate.primaryKey))) {
    errors.push(
      `Parameter '${apiName}' references object '${candidate.primaryKey}' of type '${candidate.objectType}' which does not exist in the Ontology.`,
    );
    return undefined;
  }
  return {
    objectType: candidate.objectType,
    primaryKey: candidate.primaryKey,
  };
}

async function coerceInterfaceReferenceArray(
  apiName: string,
  value: unknown,
  def: ParameterDefinition,
  objectExistsChecker: ObjectExistsChecker,
  errors: string[],
): Promise<ResolvedInterfaceReference[] | undefined> {
  if (!Array.isArray(value)) {
    errors.push(`Parameter '${apiName}' must be an array of interface references.`);
    return undefined;
  }
  const resolved: ResolvedInterfaceReference[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = await coerceInterfaceReference(
      `${apiName}[${index}]`,
      value[index],
      def,
      objectExistsChecker,
      errors,
    );
    if (item) resolved.push(item);
  }
  return resolved.length === value.length ? resolved : undefined;
}

// --- String ---
function coerceString(
  apiName: string,
  value: unknown,
  errors: string[]
): string | undefined {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else if (typeof value === "number") {
    str = String(value);
  } else if (typeof value === "boolean") {
    str = value ? "true" : "false";
  } else {
    errors.push(
      `Parameter '${apiName}' must be a string, received: ${typeof value}`
    );
    return undefined;
  }
  if (str.length > MAX_STRING_LENGTH) {
    errors.push(
      `Parameter '${apiName}' exceeds maximum string length of ${MAX_STRING_LENGTH} characters.`
    );
    return undefined;
  }
  return str;
}

// --- Boolean ---
function coerceBoolean(
  apiName: string,
  value: unknown,
  errors: string[]
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  errors.push(
    `Parameter '${apiName}' must be a boolean, received: ${typeof value}`
  );
  return undefined;
}

// --- Integer (32-bit signed) ---
function coerceInteger(
  apiName: string,
  value: unknown,
  errors: string[]
): number | undefined {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    num = parseInt(value, 10);
  } else {
    errors.push(
      `Parameter '${apiName}' must be an integer, received: '${value}'`
    );
    return undefined;
  }
  if (isNaN(num) || !Number.isInteger(num)) {
    errors.push(
      `Parameter '${apiName}' must be an integer, received: '${value}'`
    );
    return undefined;
  }
  if (num < INT32_MIN || num > INT32_MAX) {
    errors.push(
      `Parameter '${apiName}' must be a 32-bit integer (${INT32_MIN} to ${INT32_MAX}), received: ${num}`
    );
    return undefined;
  }
  return num;
}

function coerceBoundedInteger(
  apiName: string,
  value: unknown,
  minimum: number,
  maximum: number,
  typeName: string,
  errors: string[],
): number | undefined {
  const localErrors: string[] = [];
  const coerced = coerceInteger(apiName, value, localErrors);
  if (coerced === undefined) {
    errors.push(...localErrors);
    return undefined;
  }
  if (coerced < minimum || coerced > maximum) {
    errors.push(`Parameter '${apiName}' must be a ${typeName} (${minimum} to ${maximum}), received: ${coerced}`);
    return undefined;
  }
  return coerced;
}

// --- Long (64-bit signed) ---
function coerceLong(
  apiName: string,
  value: unknown,
  errors: string[]
): number | undefined {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    num = parseInt(value, 10);
  } else {
    errors.push(
      `Parameter '${apiName}' must be a long integer, received: '${value}'`
    );
    return undefined;
  }
  if (isNaN(num) || !Number.isInteger(num)) {
    errors.push(
      `Parameter '${apiName}' must be an integer, received: '${value}'`
    );
    return undefined;
  }

  // BigInt range validation
  try {
    const big = BigInt(typeof value === "string" ? value : Math.trunc(num));
    if (big < LONG_MIN || big > LONG_MAX) {
      errors.push(
        `Parameter '${apiName}' exceeds 64-bit long integer range, received: ${value}`
      );
      return undefined;
    }
  } catch {
    errors.push(
      `Parameter '${apiName}' must be a long integer, received: '${value}'`
    );
    return undefined;
  }

  // Warn if exceeds safe integer range but don't reject
  if (Math.abs(num) > Number.MAX_SAFE_INTEGER) {
    console.warn(
      `Warning: Parameter '${apiName}' value ${num} exceeds Number.MAX_SAFE_INTEGER. ` +
        `Precision may be lost in JSON serialization.`
    );
  }

  return num;
}

// --- Double / Float ---
function coerceDouble(
  apiName: string,
  value: unknown,
  paramType: string,
  errors: string[]
): number | undefined {
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string") {
    num = parseFloat(value);
  } else {
    errors.push(
      `Parameter '${apiName}' must be a finite number, received: '${value}'`
    );
    return undefined;
  }
  if (isNaN(num) || !isFinite(num)) {
    errors.push(
      `Parameter '${apiName}' must be a finite number, received: '${value}'`
    );
    return undefined;
  }
  return num;
}

// --- Date (YYYY-MM-DD) ---
function coerceDate(
  apiName: string,
  value: unknown,
  errors: string[]
): string | undefined {
  if (typeof value !== "string") {
    errors.push(
      `Parameter '${apiName}' must be a valid date in YYYY-MM-DD format, received: '${value}'`
    );
    return undefined;
  }
  if (!DATE_RE.test(value)) {
    errors.push(
      `Parameter '${apiName}' must be a valid date in YYYY-MM-DD format, received: '${value}'`
    );
    return undefined;
  }
  // Validate the date is actually valid (e.g., reject 2025-02-30)
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
    errors.push(
      `Parameter '${apiName}' must be a valid date in YYYY-MM-DD format, received: '${value}'`
    );
    return undefined;
  }
  return value;
}

// --- Timestamp (ISO 8601) ---
function coerceTimestamp(
  apiName: string,
  value: unknown,
  errors: string[]
): string | undefined {
  // Accept millisecond timestamps (numbers) and convert to ISO string
  if (typeof value === "number") {
    if (!isFinite(value)) {
      errors.push(
        `Parameter '${apiName}' must be a valid ISO 8601 timestamp, received: '${value}'`
      );
      return undefined;
    }
    return new Date(value).toISOString();
  }

  if (typeof value !== "string") {
    errors.push(
      `Parameter '${apiName}' must be a valid ISO 8601 timestamp, received: '${value}'`
    );
    return undefined;
  }

  if (!TIMESTAMP_RE.test(value)) {
    errors.push(
      `Parameter '${apiName}' must be a valid ISO 8601 timestamp, received: '${value}'`
    );
    return undefined;
  }

  // Verify the timestamp parses to a valid date
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    errors.push(
      `Parameter '${apiName}' must be a valid ISO 8601 timestamp, received: '${value}'`
    );
    return undefined;
  }

  return value;
}

// --- Object Reference ---
async function coerceObjectReference(
  apiName: string,
  value: unknown,
  def: ParameterDefinition,
  objectExistsChecker: ObjectExistsChecker,
  errors: string[]
): Promise<string | undefined> {
  if (typeof value !== "string") {
    errors.push(
      `Parameter '${apiName}' must be a string (object primary key), received: ${typeof value}`
    );
    return undefined;
  }

  const objectType = def.objectType;
  if (!objectType) {
    errors.push(
      `Parameter '${apiName}' is type 'object_reference' but has no objectType configured.`
    );
    return undefined;
  }

  const exists = await objectExistsChecker(objectType, value);
  if (!exists) {
    errors.push(
      `Parameter '${apiName}' references object '${value}' of type '${objectType}' which does not exist in the Ontology`
    );
    return undefined;
  }

  return value;
}

// --- Object Set ---
function coerceObjectSet(
  apiName: string,
  value: unknown,
  errors: string[]
): string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(
      `Parameter '${apiName}' must be an array of strings (object set), received: ${typeof value}`
    );
    return undefined;
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      errors.push(
        `Parameter '${apiName}' array element at index ${i} must be a string, received: ${typeof value[i]}`
      );
      return undefined;
    }
  }
  return value as string[];
}

// --- Typed Array (string_array, integer_array, double_array) ---
function coerceTypedArray(
  apiName: string,
  value: unknown,
  baseType: "string" | "integer" | "double" | "boolean" | "timestamp",
  errors: string[]
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(
      `Parameter '${apiName}' must be an array, received: ${typeof value}`
    );
    return undefined;
  }

  const result: unknown[] = [];
  let hasError = false;

  for (let i = 0; i < value.length; i++) {
    const elem = value[i];
    const elemErrors: string[] = [];

    let coerced: unknown;
    if (baseType === "string") {
      coerced = coerceString(`${apiName}[${i}]`, elem, elemErrors);
    } else if (baseType === "integer") {
      coerced = coerceInteger(`${apiName}[${i}]`, elem, elemErrors);
    } else if (baseType === "double") {
      // double
      coerced = coerceDouble(`${apiName}[${i}]`, elem, "double", elemErrors);
    } else if (baseType === "boolean") {
      coerced = coerceBoolean(`${apiName}[${i}]`, elem, elemErrors);
    } else {
      coerced = coerceTimestamp(`${apiName}[${i}]`, elem, elemErrors);
    }

    if (elemErrors.length > 0) {
      for (const e of elemErrors) {
        errors.push(
          `Parameter '${apiName}' array element at index ${i} is invalid: ${e}`
        );
      }
      hasError = true;
    } else {
      result.push(coerced);
    }
  }

  return hasError ? undefined : result;
}

function coerceGeopoint(
  apiName: string,
  value: unknown,
  errors: string[],
): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`Parameter '${apiName}' must be a geopoint object with lat/lon.`);
    return undefined;
  }
  const point = value as Record<string, unknown>;
  if (
    typeof point.lat !== "number" || point.lat < -90 || point.lat > 90 ||
    typeof point.lon !== "number" || point.lon < -180 || point.lon > 180
  ) {
    errors.push(`Parameter '${apiName}' must contain lat -90..90 and lon -180..180.`);
    return undefined;
  }
  return point as Record<string, number>;
}

function coerceGeoshape(
  apiName: string,
  value: unknown,
  errors: string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== "string") {
    errors.push(`Parameter '${apiName}' must be a GeoJSON object with a type field.`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

// --- Struct ---
function coerceStruct(
  apiName: string,
  value: unknown,
  errors: string[]
): Record<string, unknown> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    errors.push(
      `Parameter '${apiName}' must be a plain object (struct), received: ${
        value === null ? "null" : Array.isArray(value) ? "array" : typeof value
      }`
    );
    return undefined;
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Step 5: Constraint validation
// ---------------------------------------------------------------------------

function validateConstraints(
  def: ParameterDefinition,
  value: unknown,
  errors: string[]
): void {
  const c = def.constraints!;
  const { apiName, type: paramType } = def;

  // --- regex (string types) ---
  if (c.regex !== undefined && typeof value === "string") {
    try {
      const re = new RegExp(c.regex);
      if (!re.test(value)) {
        errors.push(
          `Parameter '${apiName}' value '${value}' does not match required pattern '${c.regex}'`
        );
      }
    } catch {
      errors.push(
        `Parameter '${apiName}' has invalid regex constraint '${c.regex}'.`
      );
    }
  }

  // --- min (numeric types) ---
  if (c.min !== undefined && typeof value === "number") {
    if (value < c.min) {
      errors.push(
        `Parameter '${apiName}' value ${value} is below minimum ${c.min}`
      );
    }
  }

  // --- max (numeric types) ---
  if (c.max !== undefined && typeof value === "number") {
    if (value > c.max) {
      errors.push(
        `Parameter '${apiName}' value ${value} exceeds maximum ${c.max}`
      );
    }
  }

  // --- minLength (string types) ---
  if (c.minLength !== undefined && typeof value === "string") {
    if (value.length < c.minLength) {
      errors.push(
        `Parameter '${apiName}' length ${value.length} is below minimum ${c.minLength}`
      );
    }
  }

  // --- maxLength (string types) ---
  if (c.maxLength !== undefined && typeof value === "string") {
    if (value.length > c.maxLength) {
      errors.push(
        `Parameter '${apiName}' length ${value.length} exceeds maximum ${c.maxLength}`
      );
    }
  }

  // --- allowedValues (string types) ---
  if (c.allowedValues !== undefined && typeof value === "string") {
    if (!c.allowedValues.includes(value)) {
      errors.push(
        `Parameter '${apiName}' value '${value}' is not one of the allowed values: ${c.allowedValues.join(", ")}`
      );
    }
  }

  // --- minItems / maxItems (array types) ---
  if (Array.isArray(value)) {
    if (c.minItems !== undefined && value.length < c.minItems) {
      errors.push(
        `Parameter '${apiName}' has ${value.length} items, expected at least ${c.minItems}`
      );
    }
    if (c.maxItems !== undefined && value.length > c.maxItems) {
      errors.push(
        `Parameter '${apiName}' has ${value.length} items, expected at most ${c.maxItems}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { validateParameters };
