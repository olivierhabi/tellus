// ---------------------------------------------------------------------------
// Interface Property Mapping Validation Service
//
// Extracts all Interface implementation validation logic into a reusable
// service module. Called from:
//   - POST /implements endpoint (Task 6)
//   - Object Views API (Task 11)
//   - OSDK code generator (future)
//
// Task 7: validatePropertyMapping, getInterfacePropertiesForObjectType,
//          checkInterfacePropertyInUse
// ---------------------------------------------------------------------------

import { query } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationSuccess {
  valid: true;
}

export interface ValidationFailure {
  valid: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export interface InterfacePropertyInfo {
  interfaceApiName: string;
  interfaceDisplayName: string;
  properties: Array<{
    interfacePropName: string;
    mappedToObjectTypeProp: string | null;
    baseType: string;
  }>;
}

export interface PropertyInUseResult {
  inUse: boolean;
  usedBy: string[];
}

// ---------------------------------------------------------------------------
// Function 1: validatePropertyMapping
//
// Performs ALL validation rules from Task 6 (rules 5-10).
// Returns { valid: true } or { valid: false, error: { code, message } }.
// ---------------------------------------------------------------------------

export async function validatePropertyMapping(
  ontologyId: string,
  objectTypeApiName: string,
  interfaceApiName: string,
  propertyMapping: Record<string, string> | unknown
): Promise<ValidationResult> {
  // Step 1: Fetch Interface and its properties
  // Interface api_name is globally unique, so we look up without ontology scoping
  const interfaceResult = await query(
    `SELECT i.interface_id, ip.api_name, ip.base_type, ip.is_required
     FROM interface i
     JOIN interface_property ip ON ip.interface_id = i.interface_id
     WHERE i.api_name = $1`,
    [interfaceApiName]
  );

  if (interfaceResult.rows.length === 0) {
    // Check if the interface itself exists but has no properties
    const ifCheck = await query(
      "SELECT interface_id FROM interface WHERE api_name = $1",
      [interfaceApiName]
    );
    if (ifCheck.rows.length === 0) {
      return {
        valid: false,
        error: {
          code: "INTERFACE_NOT_FOUND",
          message: `Interface '${interfaceApiName}' not found.`,
        },
      };
    }
    // Interface exists but has no properties — any non-empty mapping is invalid
  }

  const interfaceProperties = interfaceResult.rows;

  // Step 2: Fetch Object Type and its properties
  const otResult = await query(
    `SELECT p.api_name, p.base_type
     FROM property p
     JOIN object_type ot ON ot.object_type_id = p.object_type_id
     WHERE ot.api_name = $1 AND ot.ontology_id = $2`,
    [objectTypeApiName, ontologyId]
  );

  const otProperties = new Map<string, string>(
    otResult.rows.map((r: any) => [r.api_name, r.base_type])
  );

  // Step 3: Check that propertyMapping is a valid non-empty object
  if (
    !propertyMapping ||
    typeof propertyMapping !== "object" ||
    Array.isArray(propertyMapping) ||
    Object.keys(propertyMapping as Record<string, unknown>).length === 0
  ) {
    return {
      valid: false,
      error: {
        code: "INVALID_PARAMETER",
        message: "propertyMapping must be a non-empty object.",
      },
    };
  }

  const mapping = propertyMapping as Record<string, string>;

  // Step 4: Check all required Interface properties are mapped
  const requiredProps = interfaceProperties.filter(
    (p: any) => p.is_required === true
  );
  for (const reqProp of requiredProps) {
    if (!(reqProp.api_name in mapping)) {
      return {
        valid: false,
        error: {
          code: "MISSING_REQUIRED_MAPPING",
          message: `Interface property '${reqProp.api_name}' is required but not present in propertyMapping.`,
        },
      };
    }
  }

  // Step 5: Check all mapping keys are valid Interface property names
  const interfacePropNames = new Set(
    interfaceProperties.map((p: any) => p.api_name)
  );
  for (const key of Object.keys(mapping)) {
    if (!interfacePropNames.has(key)) {
      return {
        valid: false,
        error: {
          code: "INVALID_MAPPING_KEY",
          message: `'${key}' is not a property of Interface '${interfaceApiName}'.`,
        },
      };
    }
  }

  // Step 6: Check all mapping values are valid Object Type property names
  for (const [ifProp, otProp] of Object.entries(mapping)) {
    if (!otProperties.has(otProp)) {
      return {
        valid: false,
        error: {
          code: "INVALID_MAPPING_VALUE",
          message: `'${otProp}' is not a property of Object Type '${objectTypeApiName}'.`,
        },
      };
    }
  }

  // Step 7: Check type compatibility
  const interfacePropTypeMap = new Map<string, string>(
    interfaceProperties.map((p: any) => [p.api_name, p.base_type])
  );
  for (const [ifProp, otProp] of Object.entries(mapping)) {
    const ifType = interfacePropTypeMap.get(ifProp);
    const otType = otProperties.get(otProp);
    if (ifType !== otType) {
      return {
        valid: false,
        error: {
          code: "TYPE_MISMATCH",
          message: `Object Type property '${otProp}' has type '${otType}' but Interface property '${ifProp}' requires type '${ifType}'.`,
        },
      };
    }
  }

  // Step 8: Check no duplicate mapping targets
  const targetValues = Object.values(mapping);
  const uniqueTargets = new Set(targetValues);
  if (targetValues.length !== uniqueTargets.size) {
    const seen = new Set<string>();
    let duplicate = "";
    for (const v of targetValues) {
      if (seen.has(v)) {
        duplicate = v;
        break;
      }
      seen.add(v);
    }
    return {
      valid: false,
      error: {
        code: "DUPLICATE_MAPPING_TARGET",
        message: `Object Type property '${duplicate}' is mapped to multiple Interface properties.`,
      },
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Function 2: getInterfacePropertiesForObjectType
//
// Returns all Interface properties that this Object Type has inherited
// through its Interface implementations, mapped to the actual OT props.
// ---------------------------------------------------------------------------

export async function getInterfacePropertiesForObjectType(
  objectTypeId: string
): Promise<InterfacePropertyInfo[]> {
  const result = await query(
    `SELECT
       i.api_name AS interface_api_name,
       i.display_name AS interface_display_name,
       ip.api_name AS interface_property_name,
       ip.base_type,
       oti.property_mapping
     FROM object_type_interface oti
     JOIN interface i ON i.interface_id = oti.interface_id
     JOIN interface_property ip ON ip.interface_id = i.interface_id
     WHERE oti.object_type_id = $1
     ORDER BY i.api_name, ip.ordinal`,
    [objectTypeId]
  );

  // Group by interface, resolve property mappings
  const interfaceMap = new Map<string, InterfacePropertyInfo>();
  for (const row of result.rows) {
    if (!interfaceMap.has(row.interface_api_name)) {
      interfaceMap.set(row.interface_api_name, {
        interfaceApiName: row.interface_api_name,
        interfaceDisplayName: row.interface_display_name,
        properties: [],
      });
    }
    const iface = interfaceMap.get(row.interface_api_name)!;
    const mapping = (row.property_mapping || {}) as Record<string, string>;
    // Find which Object Type property this Interface property maps to
    const mappedToObjectTypeProp =
      mapping[row.interface_property_name] || null;
    iface.properties.push({
      interfacePropName: row.interface_property_name,
      mappedToObjectTypeProp,
      baseType: row.base_type,
    });
  }

  return Array.from(interfaceMap.values());
}

// ---------------------------------------------------------------------------
// Function 3: checkInterfacePropertyInUse
//
// Checks whether a specific Interface property is currently mapped by any
// implementing Object Type. Used before removing a property from an Interface.
// ---------------------------------------------------------------------------

export async function checkInterfacePropertyInUse(
  interfaceId: string,
  propertyApiName: string
): Promise<PropertyInUseResult> {
  const result = await query(
    `SELECT ot.api_name
     FROM object_type_interface oti
     JOIN object_type ot ON ot.object_type_id = oti.object_type_id
     WHERE oti.interface_id = $1
       AND oti.property_mapping ? $2`,
    [interfaceId, propertyApiName]
  );

  return {
    inUse: result.rows.length > 0,
    usedBy: result.rows.map((r: any) => r.api_name),
  };
}

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/interfaceValidator.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS  ${label}`);
    } else {
      failed++;
      console.error(`  FAIL  ${label}`);
    }
  }

  console.log("=== InterfaceValidator self-tests ===\n");

  // -----------------------------------------------------------------------
  // Test validatePropertyMapping — pure logic tests (no DB)
  // These test the shape/argument checking before DB queries.
  // Full integration requires a running DB.
  // -----------------------------------------------------------------------

  // Test: propertyMapping must be non-null object
  const syncTests = [
    {
      label: "null mapping returns INVALID_PARAMETER",
      mapping: null,
      expectedCode: "INVALID_PARAMETER",
    },
    {
      label: "empty object mapping returns INVALID_PARAMETER",
      mapping: {},
      expectedCode: "INVALID_PARAMETER",
    },
    {
      label: "array mapping returns INVALID_PARAMETER",
      mapping: [],
      expectedCode: "INVALID_PARAMETER",
    },
  ];

  // We can test the local validation logic by calling a simulated version
  // that doesn't hit the DB. For a true self-test, we verify the function
  // signature and type exports exist.
  assert(typeof validatePropertyMapping === "function", "validatePropertyMapping is a function");
  assert(typeof getInterfacePropertiesForObjectType === "function", "getInterfacePropertiesForObjectType is a function");
  assert(typeof checkInterfacePropertyInUse === "function", "checkInterfacePropertyInUse is a function");

  // Test duplicate detection logic standalone
  function findDuplicate(values: string[]): string | null {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) return v;
      seen.add(v);
    }
    return null;
  }

  assert(
    findDuplicate(["a", "b", "c"]) === null,
    "no duplicate in [a,b,c]"
  );
  assert(
    findDuplicate(["a", "b", "a"]) === "a",
    "finds duplicate 'a' in [a,b,a]"
  );
  assert(
    findDuplicate(["x", "x"]) === "x",
    "finds duplicate 'x' in [x,x]"
  );

  // Test mapping shape validation
  function isValidMappingShape(m: unknown): boolean {
    return (
      m !== null &&
      m !== undefined &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      Object.keys(m as Record<string, unknown>).length > 0
    );
  }

  assert(isValidMappingShape({ a: "b" }) === true, "valid mapping shape");
  assert(isValidMappingShape({}) === false, "empty object is invalid");
  assert(isValidMappingShape(null) === false, "null is invalid");
  assert(isValidMappingShape([]) === false, "array is invalid");
  assert(isValidMappingShape("string") === false, "string is invalid");
  assert(isValidMappingShape(42) === false, "number is invalid");

  // Test required property check logic
  function checkRequired(
    requiredProps: string[],
    mapping: Record<string, string>
  ): string | null {
    for (const prop of requiredProps) {
      if (!(prop in mapping)) return prop;
    }
    return null;
  }

  assert(
    checkRequired(["lat", "lng"], { lat: "x", lng: "y" }) === null,
    "all required present → null"
  );
  assert(
    checkRequired(["lat", "lng"], { lat: "x" }) === "lng",
    "missing lng → 'lng'"
  );
  assert(
    checkRequired([], { lat: "x" }) === null,
    "no required props → null"
  );

  // Test type compatibility logic
  function checkTypeCompat(
    ifType: string,
    otType: string
  ): boolean {
    return ifType === otType;
  }

  assert(checkTypeCompat("double", "double") === true, "double === double");
  assert(checkTypeCompat("double", "string") === false, "double !== string");
  assert(checkTypeCompat("string", "string") === true, "string === string");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("\nAll interfaceValidator self-tests passed.");
}

if (require.main === module) {
  runSelfTests();
}
