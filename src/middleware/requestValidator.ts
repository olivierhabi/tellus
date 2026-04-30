// ---------------------------------------------------------------------------
// Request Validation Middleware Factory (Task 17)
//
// Schema-based validation for Express request params, query, and body.
// Returns 400 with structured error listing ALL validation failures.
//
// Usage:
//   import { validateRequest } from "../middleware/requestValidator";
//
//   router.post("/items", validateRequest({
//     params: {
//       ontologyId: { required: true, type: "string", pattern: /^[a-f0-9-]+$/ },
//     },
//     body: {
//       name: { required: true, type: "string", min: 1, max: 256 },
//       count: { type: "number", min: 0, max: 10000 },
//       status: { type: "string", enum: ["active", "inactive"] },
//       tags: { type: "array", items: { type: "string" } },
//     },
//   }), handler);
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldSchema {
  /** Field is required (missing or null triggers error). */
  required?: boolean;
  /** Expected JavaScript type (checked via typeof, with special "array" handling). */
  type?: "string" | "number" | "boolean" | "object" | "array";
  /** Regex pattern the value must match (strings only). */
  pattern?: RegExp;
  /** Minimum value (numbers) or minimum length (strings/arrays). */
  min?: number;
  /** Maximum value (numbers) or maximum length (strings/arrays). */
  max?: number;
  /** Allowed values (checked via strict equality). */
  enum?: unknown[];
  /** Schema for array items (only applies when type is "array"). */
  items?: FieldSchema;
  /** Custom validation function. Return error string or null. */
  custom?: (value: unknown, field: string) => string | null;
}

export interface RequestSchema {
  params?: Record<string, FieldSchema>;
  query?: Record<string, FieldSchema>;
  body?: Record<string, FieldSchema>;
}

export interface ValidationError {
  field: string;
  message: string;
  location: "params" | "query" | "body";
}

// ---------------------------------------------------------------------------
// Core validation logic
// ---------------------------------------------------------------------------

function validateField(
  value: unknown,
  fieldName: string,
  schema: FieldSchema,
  location: string
): string[] {
  const errors: string[] = [];
  const prefix = `${location}.${fieldName}`;

  // Required check
  if (schema.required && (value === undefined || value === null || value === "")) {
    errors.push(`${prefix} is required.`);
    return errors; // Skip further checks for missing required field
  }

  // If value is absent and not required, skip all checks
  if (value === undefined || value === null) {
    return errors;
  }

  // Type check
  if (schema.type) {
    if (schema.type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${prefix} must be an array.`);
        return errors;
      }
    } else {
      const actualType = typeof value;
      if (actualType !== schema.type) {
        errors.push(
          `${prefix} must be of type ${schema.type}, got ${actualType}.`
        );
        return errors; // Wrong type — skip value-dependent checks
      }
    }
  }

  // Pattern check (strings only)
  if (schema.pattern && typeof value === "string") {
    if (!schema.pattern.test(value)) {
      errors.push(
        `${prefix} does not match required pattern ${schema.pattern}.`
      );
    }
  }

  // Min/Max for numbers
  if (typeof value === "number") {
    if (schema.min !== undefined && value < schema.min) {
      errors.push(`${prefix} must be at least ${schema.min}.`);
    }
    if (schema.max !== undefined && value > schema.max) {
      errors.push(`${prefix} must be at most ${schema.max}.`);
    }
  }

  // Min/Max for strings (length)
  if (typeof value === "string") {
    if (schema.min !== undefined && value.length < schema.min) {
      errors.push(
        `${prefix} must be at least ${schema.min} characters long.`
      );
    }
    if (schema.max !== undefined && value.length > schema.max) {
      errors.push(
        `${prefix} must be at most ${schema.max} characters long.`
      );
    }
  }

  // Min/Max for arrays (length)
  if (Array.isArray(value)) {
    if (schema.min !== undefined && value.length < schema.min) {
      errors.push(
        `${prefix} must contain at least ${schema.min} items.`
      );
    }
    if (schema.max !== undefined && value.length > schema.max) {
      errors.push(
        `${prefix} must contain at most ${schema.max} items.`
      );
    }
  }

  // Enum check
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${prefix} must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}.`
      );
    }
  }

  // Array items validation
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const itemErrors = validateField(
        value[i],
        `${fieldName}[${i}]`,
        schema.items,
        location
      );
      errors.push(...itemErrors);
    }
  }

  // Custom validator
  if (schema.custom) {
    const customError = schema.custom(value, fieldName);
    if (customError) {
      errors.push(`${prefix}: ${customError}`);
    }
  }

  return errors;
}

function validateSection(
  data: Record<string, unknown>,
  schema: Record<string, FieldSchema>,
  location: "params" | "query" | "body"
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [fieldName, fieldSchema] of Object.entries(schema)) {
    const value = data[fieldName];
    const fieldErrors = validateField(value, fieldName, fieldSchema, location);
    for (const message of fieldErrors) {
      errors.push({ field: fieldName, message, location });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create Express middleware that validates the request against a schema.
 * Validates params, query, and body sections. Collects all errors and
 * returns 400 with structured error response listing all failures.
 */
export function validateRequest(schema: RequestSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const allErrors: ValidationError[] = [];

    if (schema.params) {
      allErrors.push(
        ...validateSection(
          req.params as Record<string, unknown>,
          schema.params,
          "params"
        )
      );
    }

    if (schema.query) {
      allErrors.push(
        ...validateSection(
          req.query as Record<string, unknown>,
          schema.query,
          "query"
        )
      );
    }

    if (schema.body) {
      allErrors.push(
        ...validateSection(
          (req.body || {}) as Record<string, unknown>,
          schema.body,
          "body"
        )
      );
    }

    if (allErrors.length > 0) {
      res.status(400).json({
        error: {
          code: "VALIDATION_FAILED",
          message: `Request validation failed with ${allErrors.length} error(s).`,
          details: {
            errors: allErrors,
          },
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Inline self-tests
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
      console.log(`  PASS  ${label}`);
    } else {
      /* v8 ignore next 2 */
      failed++;
      console.log(`  FAIL  ${label}`);
    }
  }

  console.log("=== RequestValidator self-test ===\n");

  // Helper to simulate Express req/res/next
  function createMockReq(
    params: Record<string, unknown> = {},
    queryParams: Record<string, unknown> = {},
    body: Record<string, unknown> = {}
  ): any {
    return { params, query: queryParams, body };
  }

  function createMockRes(): any {
    let statusCode: number | null = null;
    let responseBody: unknown = null;
    return {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = body;
        return this;
      },
      getStatus() {
        return statusCode;
      },
      getBody() {
        return responseBody;
      },
    };
  }

  // ---- Test 1: required field missing ----
  {
    const middleware = validateRequest({
      body: { name: { required: true, type: "string" } },
    });
    const req = createMockReq({}, {}, {});
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(res.getStatus() === 400, "required missing → 400");
    assert(!nextCalled, "required missing → next not called");
    const body = res.getBody() as any;
    assert(
      body.error.details.errors[0].message.includes("is required"),
      "required missing → error message"
    );
  }

  // ---- Test 2: required field present ----
  {
    const middleware = validateRequest({
      body: { name: { required: true, type: "string" } },
    });
    const req = createMockReq({}, {}, { name: "test" });
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(nextCalled, "required present → next called");
    assert(res.getStatus() === null, "required present → no status set");
  }

  // ---- Test 3: wrong type ----
  {
    const middleware = validateRequest({
      body: { count: { type: "number" } },
    });
    const req = createMockReq({}, {}, { count: "not-a-number" });
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(res.getStatus() === 400, "wrong type → 400");
    assert(!nextCalled, "wrong type → next not called");
  }

  // ---- Test 4: pattern mismatch ----
  {
    const middleware = validateRequest({
      params: { id: { type: "string", pattern: /^[a-f0-9-]+$/ } },
    });
    const req = createMockReq({ id: "INVALID!!!" }, {}, {});
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(res.getStatus() === 400, "pattern mismatch → 400");
    const body = res.getBody() as any;
    assert(
      body.error.details.errors[0].message.includes("pattern"),
      "pattern mismatch → error mentions pattern"
    );
  }

  // ---- Test 5: min/max for numbers ----
  {
    const middleware = validateRequest({
      body: { age: { type: "number", min: 0, max: 150 } },
    });
    const req = createMockReq({}, {}, { age: -5 });
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(res.getStatus() === 400, "number too small → 400");

    const req2 = createMockReq({}, {}, { age: 200 });
    const res2 = createMockRes();
    middleware(req2, res2, () => {});
    assert(res2.getStatus() === 400, "number too large → 400");

    const req3 = createMockReq({}, {}, { age: 25 });
    const res3 = createMockRes();
    let next3 = false;
    middleware(req3, res3, () => { next3 = true; });
    assert(next3, "number in range → next called");
  }

  // ---- Test 6: min/max for strings (length) ----
  {
    const middleware = validateRequest({
      body: { name: { type: "string", min: 2, max: 10 } },
    });
    const req = createMockReq({}, {}, { name: "a" });
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "string too short → 400");

    const req2 = createMockReq({}, {}, { name: "a".repeat(20) });
    const res2 = createMockRes();
    middleware(req2, res2, () => {});
    assert(res2.getStatus() === 400, "string too long → 400");
  }

  // ---- Test 7: enum check ----
  {
    const middleware = validateRequest({
      body: { status: { type: "string", enum: ["active", "inactive"] } },
    });
    const req = createMockReq({}, {}, { status: "deleted" });
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "enum mismatch → 400");

    const req2 = createMockReq({}, {}, { status: "active" });
    const res2 = createMockRes();
    let next2 = false;
    middleware(req2, res2, () => { next2 = true; });
    assert(next2, "enum match → next called");
  }

  // ---- Test 8: array type ----
  {
    const middleware = validateRequest({
      body: { tags: { type: "array", min: 1, items: { type: "string" } } },
    });
    const req = createMockReq({}, {}, { tags: "not-array" });
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "not array → 400");

    const req2 = createMockReq({}, {}, { tags: [] });
    const res2 = createMockRes();
    middleware(req2, res2, () => {});
    assert(res2.getStatus() === 400, "empty array with min 1 → 400");

    const req3 = createMockReq({}, {}, { tags: [123] });
    const res3 = createMockRes();
    middleware(req3, res3, () => {});
    assert(res3.getStatus() === 400, "array item wrong type → 400");

    const req4 = createMockReq({}, {}, { tags: ["a", "b"] });
    const res4 = createMockRes();
    let next4 = false;
    middleware(req4, res4, () => { next4 = true; });
    assert(next4, "valid array → next called");
  }

  // ---- Test 9: custom validator ----
  {
    const middleware = validateRequest({
      body: {
        email: {
          type: "string",
          custom: (value: unknown) => {
            if (typeof value === "string" && !value.includes("@")) {
              return "must be a valid email address";
            }
            return null;
          },
        },
      },
    });
    const req = createMockReq({}, {}, { email: "notanemail" });
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "custom validator rejects → 400");

    const req2 = createMockReq({}, {}, { email: "user@example.com" });
    const res2 = createMockRes();
    let next2 = false;
    middleware(req2, res2, () => { next2 = true; });
    assert(next2, "custom validator accepts → next called");
  }

  // ---- Test 10: multiple errors collected ----
  {
    const middleware = validateRequest({
      body: {
        name: { required: true, type: "string" },
        age: { required: true, type: "number" },
        status: { type: "string", enum: ["active", "inactive"] },
      },
    });
    const req = createMockReq({}, {}, { status: "deleted" });
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "multiple errors → 400");
    const body = res.getBody() as any;
    assert(
      body.error.details.errors.length === 3,
      `multiple errors → collected 3 errors (got ${body.error.details.errors.length})`
    );
  }

  // ---- Test 11: optional field absent skips validation ----
  {
    const middleware = validateRequest({
      body: {
        name: { type: "string", min: 5 },
      },
    });
    const req = createMockReq({}, {}, {});
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(nextCalled, "optional absent → next called");
  }

  // ---- Test 12: validates across all sections ----
  {
    const middleware = validateRequest({
      params: { id: { required: true, type: "string" } },
      query: { page: { type: "number", min: 1 } },
      body: { name: { required: true, type: "string" } },
    });
    const req = createMockReq({}, { page: 0 }, {});
    const res = createMockRes();
    middleware(req, res, () => {});
    assert(res.getStatus() === 400, "cross-section validation → 400");
    const body = res.getBody() as any;
    assert(
      body.error.details.errors.length === 3,
      `cross-section → collected errors from all sections (got ${body.error.details.errors.length})`
    );
    const locations = body.error.details.errors.map((e: any) => e.location);
    assert(
      locations.includes("params") && locations.includes("query") && locations.includes("body"),
      "cross-section → errors from params, query, and body"
    );
  }

  // ---- Test 13: empty schema passes everything ----
  {
    const middleware = validateRequest({});
    const req = createMockReq({}, {}, { anything: "goes" });
    const res = createMockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert(nextCalled, "empty schema → next called");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
