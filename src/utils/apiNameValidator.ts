// ---------------------------------------------------------------------------
// API Name Validation Utility
//
// Enforces Palantir's naming conventions for Ontology resource types.
// Used by service layers to reject invalid names before they reach the DB.
// ---------------------------------------------------------------------------

import { objectIndexPrefix } from "../config/environmentIdentity";

export interface NameValidationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Reserved word lists
// ---------------------------------------------------------------------------

export const RESERVED_OBJECT_TYPE_NAMES: string[] = [
  "Object",
  "Function",
  "Action",
  "Link",
  "Interface",
  "Property",
  "Type",
  "Set",
  "Query",
  "Search",
  "Aggregate",
  "Ontology",
  "System",
];

export const RESERVED_PROPERTY_NAMES: string[] = [
  "__pk",
  "__objectType",
  "__lastModified",
  "__version",
  "__editedBy",
];

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

/** PascalCase: starts with uppercase letter, alphanumeric only, max 256 chars. */
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]{0,255}$/;

/** camelCase: starts with lowercase letter, alphanumeric only, max 256 chars. */
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]{0,255}$/;

/** Valid OpenSearch index name characters. */
const OPENSEARCH_INDEX_RE = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(): NameValidationResult {
  return { valid: true };
}

function fail(error: string): NameValidationResult {
  return { valid: false, error };
}

// ---------------------------------------------------------------------------
// Validator 1: Object Type Name (PascalCase)
// ---------------------------------------------------------------------------

export function validateObjectTypeName(name: string): NameValidationResult {
  if (name.startsWith("__")) {
    return fail(
      "Object type name cannot start with '__' (reserved for internal use)."
    );
  }
  if (RESERVED_OBJECT_TYPE_NAMES.includes(name)) {
    return fail(
      `'${name}' is a reserved word and cannot be used as an object type name.`
    );
  }
  if (!PASCAL_CASE_RE.test(name)) {
    return fail(
      `Object type name must be PascalCase (start with uppercase letter, alphanumeric only, max 256 chars). Got: '${name}'`
    );
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Validator 2: Property Name (camelCase)
// ---------------------------------------------------------------------------

export function validatePropertyName(name: string): NameValidationResult {
  if (name.startsWith("__")) {
    return fail(
      "Property name cannot start with '__' (reserved for internal use)."
    );
  }
  if (RESERVED_PROPERTY_NAMES.includes(name)) {
    return fail(`'${name}' is a reserved property name.`);
  }
  if (!CAMEL_CASE_RE.test(name)) {
    return fail(
      `Property name must be camelCase (start with lowercase letter, alphanumeric only, max 256 chars). Got: '${name}'`
    );
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Validator 3: Link Type Name (camelCase — same rules as property)
// ---------------------------------------------------------------------------

export function validateLinkTypeName(name: string): NameValidationResult {
  if (name.startsWith("__")) {
    return fail(
      "Link type name cannot start with '__' (reserved for internal use)."
    );
  }
  if (!CAMEL_CASE_RE.test(name)) {
    return fail(
      `Link type name must be camelCase (start with lowercase letter, alphanumeric only, max 256 chars). Got: '${name}'`
    );
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Validator 4: Action Type Name (camelCase — same rules as property)
// ---------------------------------------------------------------------------

export function validateActionTypeName(name: string): NameValidationResult {
  if (name.startsWith("__")) {
    return fail(
      "Action type name cannot start with '__' (reserved for internal use)."
    );
  }
  if (!CAMEL_CASE_RE.test(name)) {
    return fail(
      `Action type name must be camelCase (start with lowercase letter, alphanumeric only, max 256 chars). Got: '${name}'`
    );
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Validator 5: Interface Name (PascalCase — same rules as object type)
// ---------------------------------------------------------------------------

export function validateInterfaceName(name: string): NameValidationResult {
  if (name.startsWith("__")) {
    return fail(
      "Interface name cannot start with '__' (reserved for internal use)."
    );
  }
  if (!PASCAL_CASE_RE.test(name)) {
    return fail(
      `Interface name must be PascalCase (start with uppercase letter, alphanumeric only, max 256 chars). Got: '${name}'`
    );
  }
  return ok();
}

// ---------------------------------------------------------------------------
// Function 6: toIndexName
// ---------------------------------------------------------------------------

/**
 * Convert an object type API name to an OpenSearch index name.
 *
 * Rules:
 *   - Prefix: deployment's object-index prefix ("ontology-" by default,
 *     OS_INDEX_PREFIX overrides — e.g. test/verify envs use a dedicated
 *     prefix so they cannot touch dev indices)
 *   - apiName lowercased
 *   - Result must be all lowercase, max 255 bytes, chars in [a-z0-9-]
 *
 * Example: "Employee" -> "ontology-employee"
 */
export function toIndexName(objectTypeApiName: string): string {
  const indexName = objectIndexPrefix() + objectTypeApiName.toLowerCase();

  if (
    indexName.length > 255 ||
    !OPENSEARCH_INDEX_RE.test(indexName)
  ) {
    throw new Error(
      `Cannot convert '${objectTypeApiName}' to a valid OpenSearch index name.`
    );
  }

  return indexName;
}

// ---------------------------------------------------------------------------
// Inline self-tests (run when executed directly: tsx src/utils/apiNameValidator.ts)
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

  console.log("Running API name validator self-tests...\n");

  // 1. validateObjectTypeName('Employee') -> {valid: true}
  const r1 = validateObjectTypeName("Employee");
  assert(r1.valid === true, "validateObjectTypeName('Employee') is valid");

  // 2. validateObjectTypeName('employee') -> {valid: false} (starts lowercase)
  const r2 = validateObjectTypeName("employee");
  assert(
    r2.valid === false,
    "validateObjectTypeName('employee') is invalid (lowercase start)"
  );

  // 3. validateObjectTypeName('Object') -> {valid: false} (reserved)
  const r3 = validateObjectTypeName("Object");
  assert(
    r3.valid === false,
    "validateObjectTypeName('Object') is invalid (reserved)"
  );

  // 4. validatePropertyName('employeeId') -> {valid: true}
  const r4 = validatePropertyName("employeeId");
  assert(r4.valid === true, "validatePropertyName('employeeId') is valid");

  // 5. validatePropertyName('EmployeeId') -> {valid: false} (starts uppercase)
  const r5 = validatePropertyName("EmployeeId");
  assert(
    r5.valid === false,
    "validatePropertyName('EmployeeId') is invalid (uppercase start)"
  );

  // 6. validatePropertyName('__pk') -> {valid: false} (reserved)
  const r6 = validatePropertyName("__pk");
  assert(
    r6.valid === false,
    "validatePropertyName('__pk') is invalid (reserved)"
  );

  // 7. toIndexName('Employee') -> "<prefix>employee" (default "ontology-employee")
  assert(
    toIndexName("Employee") === `${objectIndexPrefix()}employee`,
    "toIndexName('Employee') === '<prefix>employee'"
  );

  // 8. toIndexName('CustomsDeclaration') -> "<prefix>customsdeclaration"
  assert(
    toIndexName("CustomsDeclaration") === `${objectIndexPrefix()}customsdeclaration`,
    "toIndexName('CustomsDeclaration') === '<prefix>customsdeclaration'"
  );

  // Additional coverage
  const r7 = validateObjectTypeName("__Internal");
  assert(
    r7.valid === false && r7.error!.includes("__"),
    "validateObjectTypeName('__Internal') rejects double underscore prefix"
  );

  const r8 = validateObjectTypeName("");
  assert(
    r8.valid === false,
    "validateObjectTypeName('') is invalid (empty string)"
  );

  const r9 = validatePropertyName("__objectType");
  assert(
    r9.valid === false,
    "validatePropertyName('__objectType') is invalid (reserved)"
  );

  const r10 = validateLinkTypeName("employeeOf");
  assert(r10.valid === true, "validateLinkTypeName('employeeOf') is valid");

  const r11 = validateLinkTypeName("EmployeeOf");
  assert(
    r11.valid === false,
    "validateLinkTypeName('EmployeeOf') is invalid (uppercase start)"
  );

  const r12 = validateActionTypeName("createEmployee");
  assert(
    r12.valid === true,
    "validateActionTypeName('createEmployee') is valid"
  );

  const r13 = validateInterfaceName("Searchable");
  assert(
    r13.valid === true,
    "validateInterfaceName('Searchable') is valid"
  );

  const r14 = validateInterfaceName("searchable");
  assert(
    r14.valid === false,
    "validateInterfaceName('searchable') is invalid (lowercase start)"
  );

  // Verify all reserved object type names are rejected
  for (const reserved of RESERVED_OBJECT_TYPE_NAMES) {
    const res = validateObjectTypeName(reserved);
    assert(
      res.valid === false,
      `validateObjectTypeName('${reserved}') is invalid (reserved)`
    );
  }

  // Verify all reserved property names are rejected
  for (const reserved of RESERVED_PROPERTY_NAMES) {
    const res = validatePropertyName(reserved);
    assert(
      res.valid === false,
      `validatePropertyName('${reserved}') is invalid (reserved)`
    );
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll API name validator tests passed");
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
