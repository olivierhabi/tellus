// ---------------------------------------------------------------------------
// Struct Schema Validation
//
// Validates the structSchema field for properties with baseType 'struct'.
// Handles nested structs up to 3 levels deep and generates OpenSearch
// object mappings.
//
// This module is the single source of truth for struct validation —
// propertyService delegates all struct checks here.
// ---------------------------------------------------------------------------

import { VALID_BASE_TYPES, TYPE_DEFINITIONS } from "./typeSystem";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface StructFieldDef {
  fieldName: string;
  fieldType: string;
  fieldDescription?: string;
  fieldRequired?: boolean;
  fieldSchema?: StructFieldDef[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]{0,255}$/;
const MAX_FIELDS = 50;
const MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Function 1: validateStructSchema
// ---------------------------------------------------------------------------

/**
 * Validate a struct schema array. Returns `{valid: true}` or
 * `{valid: false, errors: [...]}`.
 *
 * @param schema       The struct schema to validate (expected to be an array).
 * @param currentDepth Current nesting depth (1 = root struct). Max is 3.
 */
export function validateStructSchema(
  schema: unknown,
  currentDepth: number = 1
): StructValidationResult {
  const errors: string[] = [];

  // 6. Check max nesting depth first
  if (currentDepth > MAX_DEPTH) {
    errors.push("Struct nesting exceeds maximum depth of 3 levels.");
    return { valid: false, errors };
  }

  // 1. Must be a non-null array
  if (!Array.isArray(schema) || schema === null) {
    errors.push("Struct schema must be a non-null array.");
    return { valid: false, errors };
  }

  // 2. Must have at least one element
  if (schema.length === 0) {
    errors.push("Struct schema must contain at least one field.");
    return { valid: false, errors };
  }

  // 3. Must have at most 50 elements
  if (schema.length > MAX_FIELDS) {
    errors.push(
      `Struct schema exceeds maximum of 50 fields (has ${schema.length}).`
    );
    return { valid: false, errors };
  }

  // Track field names for duplicate check
  const seenFieldNames = new Set<string>();

  // 4. Validate each element
  for (let i = 0; i < schema.length; i++) {
    const element = schema[i];

    // 4a. Must be an object (not null, not array)
    if (
      element === null ||
      typeof element !== "object" ||
      Array.isArray(element)
    ) {
      errors.push(`Struct schema element at index ${i} must be an object.`);
      continue;
    }

    const field = element as Record<string, unknown>;

    // 4b. Must have fieldName (string)
    if (!field.fieldName || typeof field.fieldName !== "string") {
      errors.push(
        `Field at index ${i} is missing required property 'fieldName'.`
      );
      // Can't do further name-based checks without fieldName
      // But continue to check fieldType
    }

    // 4c. Must have fieldType (string)
    if (!field.fieldType || typeof field.fieldType !== "string") {
      errors.push(
        `Field at index ${i} is missing required property 'fieldType'.`
      );
      continue; // Can't validate further without fieldType
    }

    const fieldName = field.fieldName as string;
    const fieldType = field.fieldType as string;

    // 4d. fieldName must match camelCase regex
    if (fieldName && !CAMEL_CASE_RE.test(fieldName)) {
      errors.push(
        `Field '${fieldName}' must be camelCase (start with lowercase, alphanumeric only).`
      );
    }

    // 4e. fieldType must be in VALID_BASE_TYPES
    if (!VALID_BASE_TYPES.includes(fieldType)) {
      errors.push(
        `Field '${fieldName}' has invalid type '${fieldType}'. Valid types: ${VALID_BASE_TYPES.join(", ")}.`
      );
      continue; // Can't check nested struct if type is invalid
    }

    // 4g. If fieldType is 'struct', must have fieldSchema
    if (fieldType === "struct") {
      if (!field.fieldSchema) {
        errors.push(
          `Field '${fieldName}' has type 'struct' but is missing 'fieldSchema'.`
        );
      } else {
        // Recursively validate nested struct
        const nested = validateStructSchema(
          field.fieldSchema,
          currentDepth + 1
        );
        if (!nested.valid && nested.errors) {
          errors.push(...nested.errors);
        }
      }
    }

    // 5. Track fieldName for duplicate check
    if (fieldName) {
      if (seenFieldNames.has(fieldName)) {
        errors.push(`Duplicate field name '${fieldName}' in struct schema.`);
      } else {
        seenFieldNames.add(fieldName);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Function 2: generateOpenSearchStructMapping
// ---------------------------------------------------------------------------

/**
 * Recursively build the OpenSearch object mapping from a validated struct
 * schema. For each field, looks up the OpenSearch mapping from the type
 * system and nests appropriately.
 *
 * @param structSchema A validated struct schema array.
 * @returns OpenSearch mapping object with `{type: "object", properties: {...}}`.
 */
export function generateOpenSearchStructMapping(
  structSchema: StructFieldDef[]
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of structSchema) {
    if (field.fieldType === "struct" && field.fieldSchema) {
      // Recurse for nested structs
      properties[field.fieldName] = generateOpenSearchStructMapping(
        field.fieldSchema
      );
    } else {
      // Look up the type's OpenSearch mapping
      const typeDef = TYPE_DEFINITIONS[field.fieldType];
      if (typeDef) {
        properties[field.fieldName] = { ...typeDef.opensearchMapping };
      }
    }
  }

  return {
    type: "object",
    properties,
  };
}

// ---------------------------------------------------------------------------
// Inline self-tests (run directly: npx tsx src/utils/structValidator.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS: ${label}`);
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running struct validator self-tests...\n");

  // === validateStructSchema ===

  // 1. Valid simple schema
  const r1 = validateStructSchema([
    { fieldName: "street", fieldType: "string" },
  ]);
  assert(r1.valid === true, "Valid simple schema → valid");

  // 2. Missing fieldName
  const r2 = validateStructSchema([{ fieldType: "string" }]);
  assert(r2.valid === false, "Missing fieldName → invalid");
  assert(
    r2.errors!.some((e) => e.includes("missing required property 'fieldName'")),
    "Error mentions missing fieldName"
  );

  // 3. Invalid fieldType
  const r3 = validateStructSchema([
    { fieldName: "foo", fieldType: "invalid" },
  ]);
  assert(r3.valid === false, "Invalid fieldType → invalid");
  assert(
    r3.errors!.some((e) => e.includes("invalid type 'invalid'")),
    "Error mentions invalid type"
  );

  // 4. Duplicate fieldNames
  const r4 = validateStructSchema([
    { fieldName: "street", fieldType: "string" },
    { fieldName: "street", fieldType: "string" },
  ]);
  assert(r4.valid === false, "Duplicate fieldNames → invalid");
  assert(
    r4.errors!.some((e) => e.includes("Duplicate field name 'street'")),
    "Error mentions duplicate"
  );

  // 5. Nested struct (2 levels) — valid
  const r5 = validateStructSchema([
    {
      fieldName: "address",
      fieldType: "struct",
      fieldSchema: [
        { fieldName: "street", fieldType: "string" },
        { fieldName: "city", fieldType: "string" },
      ],
    },
  ]);
  assert(r5.valid === true, "Nested struct (2 levels) → valid");

  // 6. Nested struct (3 levels) — valid
  const r6 = validateStructSchema([
    {
      fieldName: "level1",
      fieldType: "struct",
      fieldSchema: [
        {
          fieldName: "level2",
          fieldType: "struct",
          fieldSchema: [{ fieldName: "value", fieldType: "integer" }],
        },
      ],
    },
  ]);
  assert(r6.valid === true, "Nested struct (3 levels) → valid");

  // 7. Nested struct (4 levels) — EXCEEDS max depth
  const r7 = validateStructSchema([
    {
      fieldName: "l1",
      fieldType: "struct",
      fieldSchema: [
        {
          fieldName: "l2",
          fieldType: "struct",
          fieldSchema: [
            {
              fieldName: "l3",
              fieldType: "struct",
              fieldSchema: [{ fieldName: "l4", fieldType: "string" }],
            },
          ],
        },
      ],
    },
  ]);
  assert(r7.valid === false, "Nested struct (4 levels) → invalid");
  assert(
    r7.errors!.some((e) => e.includes("exceeds maximum depth of 3")),
    "Error mentions max depth"
  );

  // 8. 51 fields → exceeds max
  const bigSchema = Array.from({ length: 51 }, (_, i) => ({
    fieldName: `field${i}`,
    fieldType: "string",
  }));
  const r8 = validateStructSchema(bigSchema);
  assert(r8.valid === false, "51 fields → invalid");
  assert(
    r8.errors!.some((e) => e.includes("exceeds maximum of 50 fields")),
    "Error mentions max fields"
  );

  // 9. Not an array
  const r9 = validateStructSchema("not_an_array");
  assert(r9.valid === false, "Non-array → invalid");
  assert(
    r9.errors!.some((e) => e.includes("must be a non-null array")),
    "Error mentions non-null array"
  );

  // 10. Empty array
  const r10 = validateStructSchema([]);
  assert(r10.valid === false, "Empty array → invalid");
  assert(
    r10.errors!.some((e) => e.includes("at least one field")),
    "Error mentions at least one field"
  );

  // 11. Null schema
  const r11 = validateStructSchema(null);
  assert(r11.valid === false, "Null → invalid");

  // 12. Bad fieldName format (starts with uppercase)
  const r12 = validateStructSchema([
    { fieldName: "BadName", fieldType: "string" },
  ]);
  assert(r12.valid === false, "Uppercase fieldName → invalid");
  assert(
    r12.errors!.some((e) => e.includes("must be camelCase")),
    "Error mentions camelCase"
  );

  // 13. Struct field missing fieldSchema
  const r13 = validateStructSchema([
    { fieldName: "nested", fieldType: "struct" },
  ]);
  assert(r13.valid === false, "Struct without fieldSchema → invalid");
  assert(
    r13.errors!.some((e) => e.includes("missing 'fieldSchema'")),
    "Error mentions missing fieldSchema"
  );

  // 14. Element is not an object (e.g., string)
  const r14 = validateStructSchema(["not_an_object"]);
  assert(r14.valid === false, "Non-object element → invalid");
  assert(
    r14.errors!.some((e) => e.includes("must be an object")),
    "Error mentions must be object"
  );

  // 15. Valid schema with optional fields
  const r15 = validateStructSchema([
    {
      fieldName: "note",
      fieldType: "string",
      fieldDescription: "A note",
      fieldRequired: true,
    },
  ]);
  assert(r15.valid === true, "Optional fields (description, required) → valid");

  console.log("\n--- generateOpenSearchStructMapping ---\n");

  // 16. Simple struct mapping
  const m1 = generateOpenSearchStructMapping([
    { fieldName: "street", fieldType: "string" },
    { fieldName: "city", fieldType: "string" },
  ]);
  assert(m1.type === "object", "Root type is 'object'");
  assert(
    typeof m1.properties === "object" && m1.properties !== null,
    "Has properties object"
  );
  const props1 = m1.properties as Record<string, any>;
  assert(
    props1.street?.type === "text",
    "string → text mapping for street"
  );
  assert(
    props1.city?.type === "text",
    "string → text mapping for city"
  );

  // 17. Nested struct mapping
  const m2 = generateOpenSearchStructMapping([
    { fieldName: "street", fieldType: "string" },
    { fieldName: "city", fieldType: "string" },
    {
      fieldName: "coordinates",
      fieldType: "struct",
      fieldSchema: [
        { fieldName: "lat", fieldType: "double" },
        { fieldName: "lon", fieldType: "double" },
      ],
    },
  ]);
  const props2 = m2.properties as Record<string, any>;
  assert(
    props2.coordinates?.type === "object",
    "Nested struct → type 'object'"
  );
  assert(
    props2.coordinates?.properties?.lat?.type === "double",
    "Nested lat → double"
  );
  assert(
    props2.coordinates?.properties?.lon?.type === "double",
    "Nested lon → double"
  );

  // 18. Various base type mappings
  const m3 = generateOpenSearchStructMapping([
    { fieldName: "count", fieldType: "integer" },
    { fieldName: "active", fieldType: "boolean" },
    { fieldName: "createdAt", fieldType: "date" },
    { fieldName: "location", fieldType: "geopoint" },
  ]);
  const props3 = m3.properties as Record<string, any>;
  assert(props3.count?.type === "integer", "integer → integer");
  assert(props3.active?.type === "boolean", "boolean → boolean");
  assert(props3.createdAt?.type === "date", "date → date");
  assert(props3.location?.type === "geo_point", "geopoint → geo_point");

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll struct validator tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
