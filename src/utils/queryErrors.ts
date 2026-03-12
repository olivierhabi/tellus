// ---------------------------------------------------------------------------
// Query Error Classes (Task 15)
//
// Error hierarchy for the Object Set Service. Each error class sets its own
// HTTP status code and machine-readable error code.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Levenshtein distance (for "did you mean?" suggestions)
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export class OntologyError extends Error {
  code: string;
  statusCode: number;
  details: Record<string, unknown>;

  constructor(message: string, code: string, statusCode: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "OntologyError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Specific error classes
// ---------------------------------------------------------------------------

export class ObjectTypeNotFoundError extends OntologyError {
  constructor(objectType: string, availableTypes: string[] = []) {
    const msg = `Object type '${objectType}' not found. Available types: ${availableTypes.join(", ") || "(none)"}.`;
    super(msg, "OBJECT_TYPE_NOT_FOUND", 404, { objectType, availableTypes });
    this.name = "ObjectTypeNotFoundError";
  }
}

export class ObjectNotFoundError extends OntologyError {
  constructor(objectType: string, primaryKey: string) {
    super(
      `Object '${primaryKey}' not found in object type '${objectType}'.`,
      "OBJECT_NOT_FOUND", 404, { objectType, primaryKey }
    );
    this.name = "ObjectNotFoundError";
  }
}

export class PropertyNotFoundError extends OntologyError {
  constructor(property: string, objectType: string, validProperties: string[] = []) {
    const suggestions = validProperties
      .map((p) => ({ name: p, dist: levenshteinDistance(property.toLowerCase(), p.toLowerCase()) }))
      .filter((s) => s.dist <= 2)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((s) => s.name);

    const msg = suggestions.length > 0
      ? `Property '${property}' not found on object type '${objectType}'. Did you mean: ${suggestions.join(", ")}?`
      : `Property '${property}' not found on object type '${objectType}'. Valid properties: ${validProperties.join(", ")}.`;

    super(msg, "PROPERTY_NOT_FOUND", 400, { property, objectType, validProperties, suggestions });
    this.name = "PropertyNotFoundError";
  }
}

export class QueryValidationError extends OntologyError {
  constructor(message: string, field: string | null = null) {
    super(message, "INVALID_QUERY", 400, { field });
    this.name = "QueryValidationError";
  }
}

export class IncompatibleFilterError extends OntologyError {
  constructor(filterType: string, property: string, propertyType: string) {
    super(
      `Filter '${filterType}' is not compatible with property '${property}' of type '${propertyType}'.`,
      "INCOMPATIBLE_FILTER", 400, { filterType, property, propertyType }
    );
    this.name = "IncompatibleFilterError";
  }
}

export class PageTokenError extends OntologyError {
  constructor(reason: string) {
    super(`Invalid page token: ${reason}.`, "INVALID_PAGE_TOKEN", 400, { reason });
    this.name = "PageTokenError";
  }
}

export class ObjectDatabaseUnavailableError extends OntologyError {
  constructor(message = "OpenSearch is currently unavailable. Please try again.") {
    super(message, "OBJECT_DATABASE_UNAVAILABLE", 503, {});
    this.name = "ObjectDatabaseUnavailableError";
  }
}

export class MetadataStoreUnavailableError extends OntologyError {
  constructor(message = "PostgreSQL is currently unavailable. Please try again.") {
    super(message, "METADATA_STORE_UNAVAILABLE", 503, {});
    this.name = "MetadataStoreUnavailableError";
  }
}

export class AggregationError extends OntologyError {
  constructor(message: string) {
    super(message, "INVALID_AGGREGATION", 400, {});
    this.name = "AggregationError";
  }
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

  console.log("=== QueryErrors self-test ===");

  const propErr = new PropertyNotFoundError("deparment", "Employee", ["department", "employeeId", "salary"]);
  assert(propErr.message.includes("Did you mean: department"), "PropertyNotFound suggests 'department'");
  assert(propErr.statusCode === 400, "PropertyNotFound is 400");
  assert(propErr.code === "PROPERTY_NOT_FOUND", "PropertyNotFound code correct");

  const propErr2 = new PropertyNotFoundError("xyz", "Employee", ["department", "employeeId"]);
  assert(!propErr2.message.includes("Did you mean"), "No suggestion for 'xyz' (distance > 2)");
  assert(propErr2.message.includes("Valid properties"), "Falls back to listing valid properties");

  const otErr = new ObjectTypeNotFoundError("Employe", ["Employee", "Company"]);
  assert(otErr.statusCode === 404, "ObjectTypeNotFound is 404");
  assert(otErr.message.includes("Employee, Company"), "Lists available types");

  const qErr = new QueryValidationError("bad query", "$pageSize");
  assert(qErr.statusCode === 400, "QueryValidation is 400");
  assert(qErr.code === "INVALID_QUERY", "QueryValidation code correct");

  const dbErr = new ObjectDatabaseUnavailableError();
  assert(dbErr.statusCode === 503, "DatabaseUnavailable is 503");

  assert(new OntologyError("test", "TEST", 500) instanceof Error, "OntologyError extends Error");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
