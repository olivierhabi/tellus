// ---------------------------------------------------------------------------
// Input Sanitization Middleware (Task 18)
//
// Sanitizes all incoming request inputs (body, query, params) to prevent
// injection attacks and ensure consistent data quality.
//
// Features:
//   - Trims whitespace from string values
//   - Strips null bytes (\0) from strings
//   - Normalizes Unicode (NFC form)
//   - Limits string length (configurable, default 10000 chars)
//   - Rejects requests with nested objects deeper than 10 levels
//   - XSS prevention: strips <script> tags from string inputs
//
// Run self-tests: npx tsx src/middleware/inputSanitizer.ts
// ---------------------------------------------------------------------------

import { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SanitizerOptions {
  /** Maximum allowed string length (default 10000). */
  maxStringLength?: number;
  /** Maximum nesting depth for objects/arrays (default 10). */
  maxDepth?: number;
  /** Whether to strip <script> tags (default true). */
  stripScriptTags?: boolean;
  /**
   * Predicate that, when it returns true for a request, SKIPS body string
   * mutation (truncation / trim / script-strip) for that request. The depth
   * guard still runs (cheap DoS protection). Use for routes whose body is a
   * large, schema-validated, size-capped structured document where silently
   * truncating an embedded string would corrupt it — e.g. a Workshop module
   * definition carrying a Vega spec JSON string longer than `maxStringLength`.
   * Query and route params are always sanitized.
   */
  shouldSkipBody?: (req: Request) => boolean;
  /**
   * Optional per-route depth-guard override. Workshop module definitions are
   * managed, schema-validated documents that legitimately nest deeper than
   * the generic API default (widget configs carrying linked-filter chains,
   * event payloads, etc.) — Palantir module documents have no equivalent
   * shallow cap. When provided and the predicate matches, this depth is used
   * instead of `maxDepth` (still a hard DoS guard, just a realistic one).
   */
  maxDepthForRoute?: (req: Request) => number | undefined;
}

const DEFAULT_MAX_STRING_LENGTH = 10000;
const DEFAULT_MAX_DEPTH = 10;

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** Matches <script>...</script> tags (case-insensitive, multiline). */
const SCRIPT_TAG_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;

/** Matches standalone <script> or </script> opening/closing tags. */
const SCRIPT_OPEN_CLOSE_RE = /<\/?script\b[^>]*>/gi;

/** Matches null bytes. */
const NULL_BYTE_RE = /\0/g;

// ---------------------------------------------------------------------------
// Core sanitization function
// ---------------------------------------------------------------------------

/**
 * Sanitize a single string value.
 *
 * 1. Strip null bytes
 * 2. Normalize Unicode to NFC
 * 3. Trim whitespace
 * 4. Strip <script> tags
 * 5. Truncate to maxStringLength
 */
export function sanitizeString(
  value: string,
  maxLength: number,
  stripScripts: boolean
): string {
  let result = value;

  // 1. Strip null bytes
  result = result.replace(NULL_BYTE_RE, "");

  // 2. Normalize Unicode to NFC
  result = result.normalize("NFC");

  // 3. Trim whitespace
  result = result.trim();

  // 4. Strip <script> tags (basic XSS prevention)
  if (stripScripts) {
    result = result.replace(SCRIPT_TAG_RE, "");
    result = result.replace(SCRIPT_OPEN_CLOSE_RE, "");
  }

  // 5. Truncate to max length
  if (result.length > maxLength) {
    result = result.substring(0, maxLength);
  }

  return result;
}

/**
 * Check if a value's nesting depth exceeds the limit.
 * Returns true if depth is exceeded (i.e., the value is too deep).
 */
export function exceedsDepth(value: unknown, maxDepth: number, currentDepth: number = 0): boolean {
  if (currentDepth > maxDepth) {
    return true;
  }

  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (exceedsDepth(item, maxDepth, currentDepth + 1)) {
        return true;
      }
    }
    return false;
  }

  // Plain object
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (exceedsDepth((value as Record<string, unknown>)[key], maxDepth, currentDepth + 1)) {
      return true;
    }
  }

  return false;
}

/**
 * Recursively sanitize an object/array/value.
 * Returns a new sanitized copy (does not mutate the input).
 */
export function sanitizeValue(
  value: unknown,
  maxLength: number,
  stripScripts: boolean
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return sanitizeString(value, maxLength, stripScripts);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, maxLength, stripScripts));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Also sanitize keys (strip null bytes, normalize Unicode)
      const cleanKey = sanitizeString(key, maxLength, false);
      result[cleanKey] = sanitizeValue(val, maxLength, stripScripts);
    }
    return result;
  }

  return value;
}

// ---------------------------------------------------------------------------
// Express Middleware
// ---------------------------------------------------------------------------

/**
 * Create input sanitization middleware with the given options.
 */
export function createInputSanitizer(options: SanitizerOptions = {}) {
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const stripScriptTags = options.stripScriptTags ?? true;
  const shouldSkipBody = options.shouldSkipBody;
  const maxDepthForRoute = options.maxDepthForRoute;

  return function inputSanitizer(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Check nesting depth on body
    const bodyMaxDepth = maxDepthForRoute?.(req) ?? maxDepth;
    if (req.body && typeof req.body === "object") {
      if (exceedsDepth(req.body, bodyMaxDepth)) {
        res.status(400).json({
          error: {
            code: "VALIDATION_FAILED",
            message: `Request body exceeds maximum nesting depth of ${bodyMaxDepth} levels.`,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      // Skip string mutation for routes carrying large, schema-validated,
      // size-capped structured bodies (e.g. a Workshop module definition with
      // an embedded Vega spec) — truncating an embedded JSON string there is
      // silent data corruption. The depth guard above still applies.
      if (!shouldSkipBody || !shouldSkipBody(req)) {
        req.body = sanitizeValue(req.body, maxStringLength, stripScriptTags);
      }
    }

    // Sanitize query parameters
    if (req.query && typeof req.query === "object") {
      if (exceedsDepth(req.query, maxDepth)) {
        res.status(400).json({
          error: {
            code: "VALIDATION_FAILED",
            message: `Query parameters exceed maximum nesting depth of ${maxDepth} levels.`,
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }
      req.query = sanitizeValue(req.query, maxStringLength, stripScriptTags) as typeof req.query;
    }

    // Sanitize route parameters
    if (req.params && typeof req.params === "object") {
      const sanitizedParams = sanitizeValue(
        req.params,
        maxStringLength,
        stripScriptTags
      ) as Record<string, string>;
      // req.params is read-only in newer Express, so we replace values in-place
      for (const [key, val] of Object.entries(sanitizedParams)) {
        req.params[key] = val;
      }
    }

    next();
  };
}

/**
 * Default input sanitizer middleware with standard options.
 */
export const inputSanitizer = createInputSanitizer();

export default inputSanitizer;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/middleware/inputSanitizer.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      /* v8 ignore next 2 */
      failed++;
    }
  }

  console.log("Running inputSanitizer self-tests...\n");

  // =========================================================================
  // 1. sanitizeString: trim whitespace
  // =========================================================================
  console.log("=== 1. Trim whitespace ===");
  {
    assert(
      sanitizeString("  hello  ", 10000, false) === "hello",
      "trims leading/trailing whitespace"
    );
    assert(
      sanitizeString("\t\n foo \r\n", 10000, false) === "foo",
      "trims tabs, newlines"
    );
    assert(
      sanitizeString("", 10000, false) === "",
      "empty string stays empty"
    );
  }

  // =========================================================================
  // 2. sanitizeString: strip null bytes
  // =========================================================================
  console.log("\n=== 2. Strip null bytes ===");
  {
    assert(
      sanitizeString("he\0llo", 10000, false) === "hello",
      "strips null byte from middle"
    );
    assert(
      sanitizeString("\0\0test\0", 10000, false) === "test",
      "strips multiple null bytes"
    );
  }

  // =========================================================================
  // 3. sanitizeString: Unicode NFC normalization
  // =========================================================================
  console.log("\n=== 3. Unicode NFC normalization ===");
  {
    // é as combining characters (NFD: e + combining acute accent)
    const nfd = "e\u0301"; // "é" in NFD
    const nfc = "\u00E9";  // "é" in NFC
    const result = sanitizeString(nfd, 10000, false);
    assert(result === nfc, `NFD "${nfd}" normalized to NFC "${nfc}" (got: "${result}")`);
    assert(result.length === 1, `NFC form is single char (got: ${result.length})`);
  }

  // =========================================================================
  // 4. sanitizeString: max length truncation
  // =========================================================================
  console.log("\n=== 4. Max length truncation ===");
  {
    const long = "a".repeat(20000);
    const result = sanitizeString(long, 10000, false);
    assert(result.length === 10000, `truncated to 10000 (got: ${result.length})`);

    const short = "hello";
    assert(
      sanitizeString(short, 10000, false) === "hello",
      "short string not truncated"
    );

    // Custom max length
    assert(
      sanitizeString("abcdef", 3, false) === "abc",
      "custom max length 3"
    );
  }

  // =========================================================================
  // 5. sanitizeString: strip <script> tags
  // =========================================================================
  console.log("\n=== 5. Strip <script> tags ===");
  {
    assert(
      sanitizeString('<script>alert("xss")</script>', 10000, true) === "",
      "strips complete script tag"
    );
    assert(
      sanitizeString('Hello <script>evil()</script> World', 10000, true) === "Hello  World",
      "strips script tag from middle"
    );
    assert(
      sanitizeString('<SCRIPT>alert(1)</SCRIPT>', 10000, true) === "",
      "case-insensitive script removal"
    );
    assert(
      sanitizeString('<script type="text/javascript">code</script>', 10000, true) === "",
      "strips script with attributes"
    );
    assert(
      sanitizeString('foo <script>bar</script> baz <script>qux</script> end', 10000, true) === "foo  baz  end",
      "strips multiple script tags"
    );
    assert(
      sanitizeString('test <script>code', 10000, true) === "test code",
      "strips orphan opening script tag (leaves inner text)"
    );
    assert(
      sanitizeString('test </script> end', 10000, true) === "test  end",
      "strips orphan closing script tag"
    );
    // No scripts: passthrough
    assert(
      sanitizeString("safe text <b>bold</b>", 10000, true) === "safe text <b>bold</b>",
      "preserves non-script HTML"
    );
  }

  // =========================================================================
  // 6. exceedsDepth: basic depth checks
  // =========================================================================
  console.log("\n=== 6. Depth checking ===");
  {
    assert(!exceedsDepth("hello", 10), "string: no depth issue");
    assert(!exceedsDepth(42, 10), "number: no depth issue");
    assert(!exceedsDepth(null, 10), "null: no depth issue");
    assert(!exceedsDepth({}, 10), "empty object: no depth issue");
    assert(!exceedsDepth([], 10), "empty array: no depth issue");

    // 1 level deep
    assert(!exceedsDepth({ a: 1 }, 1), "1 level within limit");
    assert(!exceedsDepth({ a: { b: 1 } }, 2), "2 levels within limit");

    // Exceeds depth
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 1 } } } } } } } } } } };
    assert(exceedsDepth(deep, 10), "11-level object exceeds depth 10");
    assert(!exceedsDepth(deep, 11), "11-level object within depth 11");

    // Array nesting
    const deepArray = [[[[[[[[[[["value"]]]]]]]]]]];
    assert(exceedsDepth(deepArray, 10), "11-level array exceeds depth 10");
    assert(!exceedsDepth(deepArray, 11), "11-level array within depth 11");

    // Mixed nesting
    const mixed = { a: [{ b: [{ c: 1 }] }] };
    assert(!exceedsDepth(mixed, 5), "mixed nesting within limit");
    assert(exceedsDepth(mixed, 3), "mixed nesting exceeds limit 3");
  }

  // =========================================================================
  // 7. sanitizeValue: recursive sanitization
  // =========================================================================
  console.log("\n=== 7. Recursive sanitization ===");
  {
    const input = {
      name: "  John\0 ",
      age: 30,
      active: true,
      tags: ["  admin\0  ", "  user  "],
      nested: {
        bio: '<script>alert("xss")</script>Safe text',
      },
    };

    const result = sanitizeValue(input, 10000, true) as Record<string, unknown>;
    assert(result.name === "John", "sanitized name");
    assert(result.age === 30, "number preserved");
    assert(result.active === true, "boolean preserved");
    assert((result.tags as string[])[0] === "admin", "array item sanitized");
    assert((result.tags as string[])[1] === "user", "array item trimmed");
    assert(
      (result.nested as Record<string, unknown>).bio === "Safe text",
      "nested script tag removed"
    );
  }

  // =========================================================================
  // 8. sanitizeValue: null/undefined passthrough
  // =========================================================================
  console.log("\n=== 8. Null/undefined passthrough ===");
  {
    assert(sanitizeValue(null, 10000, true) === null, "null passthrough");
    assert(sanitizeValue(undefined, 10000, true) === undefined, "undefined passthrough");
  }

  // =========================================================================
  // 9. createInputSanitizer: middleware behavior
  // =========================================================================
  console.log("\n=== 9. Middleware behavior ===");
  {
    const middleware = createInputSanitizer({ maxStringLength: 50, maxDepth: 3 });

    // Simulate Express request/response
    let nextCalled = false;
    const mockReq = {
      body: { name: "  test\0  ", description: '<script>xss</script>clean' },
      query: { search: "  foo\0  " },
      params: { id: "  123\0  " },
    } as unknown as Request;

    const mockRes = {
      status: () => mockRes,
      json: () => mockRes,
    } as unknown as Response;

    middleware(mockReq, mockRes, () => { nextCalled = true; });

    assert(nextCalled, "next() was called");
    assert(mockReq.body.name === "test", "body sanitized");
    assert(mockReq.body.description === "clean", "body script tags removed");
    assert((mockReq.query as any).search === "foo", "query sanitized");
    assert(mockReq.params.id === "123", "params sanitized");
  }

  // =========================================================================
  // 10. createInputSanitizer: rejects deep nesting
  // =========================================================================
  console.log("\n=== 10. Rejects deep nesting ===");
  {
    const middleware = createInputSanitizer({ maxDepth: 3 });

    let nextCalled = false;
    let responseStatus = 0;
    let responseBody: any = null;

    const deep = { a: { b: { c: { d: 1 } } } }; // 4 levels deep
    const mockReq = {
      body: deep,
      query: {},
      params: {},
    } as unknown as Request;

    const mockRes = {
      status: (code: number) => { responseStatus = code; return mockRes; },
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    middleware(mockReq, mockRes, () => { nextCalled = true; });

    assert(!nextCalled, "next() NOT called for deep nesting");
    assert(responseStatus === 400, "returns 400 for deep nesting");
    assert(
      responseBody?.error?.code === "VALIDATION_FAILED",
      "error code is VALIDATION_FAILED"
    );
  }

  // =========================================================================
  // 11. Combined sanitization: all transformations applied
  // =========================================================================
  console.log("\n=== 11. Combined sanitization ===");
  {
    const input = "  \0He\u0301llo\0 <script>x</script> World  ";
    const result = sanitizeString(input, 10000, true);
    // After: strip \0 -> "  Héllo  World  "
    // After NFC: H + combining accent -> single char
    // After trim: "Héllo  World"
    // After strip scripts: "Héllo  World"
    assert(
      result.includes("H") && result.includes("World"),
      "combined sanitization preserves content"
    );
    assert(!result.includes("\0"), "no null bytes remain");
    assert(!result.includes("<script"), "no script tags remain");
    assert(result === result.trim(), "result is trimmed");
  }

  // =========================================================================
  // 12. String length with custom options
  // =========================================================================
  console.log("\n=== 12. Custom maxStringLength ===");
  {
    const middleware = createInputSanitizer({ maxStringLength: 5 });
    let nextCalled = false;

    const mockReq = {
      body: { name: "abcdefghij" },
      query: {},
      params: {},
    } as unknown as Request;

    const mockRes = {
      status: () => mockRes,
      json: () => mockRes,
    } as unknown as Response;

    middleware(mockReq, mockRes, () => { nextCalled = true; });

    assert(nextCalled, "next() called");
    assert(mockReq.body.name === "abcde", `truncated to 5 chars (got: "${mockReq.body.name}")`);
  }

  // =========================================================================
  // 13. shouldSkipBody: large structured bodies are not string-mutated
  // =========================================================================
  console.log("\n=== 13. shouldSkipBody (workshop module path) ===");
  {
    const middleware = createInputSanitizer({
      shouldSkipBody: (req) => (req.path || "").startsWith("/api/v1/workshop"),
    });
    const bigSpec = "x".repeat(16000); // a Vega spec longer than the 10k cap

    // (a) Skipped path: the body string survives intact (no truncation/trim).
    let nextA = false;
    const reqA = {
      path: "/api/v1/workshop/modules/ri.workshop.main.module.x",
      body: { definition: { spec: "  " + bigSpec + "  " } },
      query: {},
      params: {},
    } as unknown as Request;
    const resNoop = { status: () => resNoop, json: () => resNoop } as unknown as Response;
    middleware(reqA, resNoop, () => { nextA = true; });
    assert(nextA, "skipped path: next() called");
    assert(
      (reqA.body.definition.spec as string).length === bigSpec.length + 4,
      `skipped path: 16k spec NOT truncated/trimmed (got ${(reqA.body.definition.spec as string).length})`,
    );

    // (b) Non-skipped path: the default 10k truncation still applies.
    let nextB = false;
    const reqB = {
      path: "/api/v1/objects/Foo/search",
      body: { note: bigSpec },
      query: {},
      params: {},
    } as unknown as Request;
    middleware(reqB, resNoop, () => { nextB = true; });
    assert(nextB, "non-skipped path: next() called");
    assert(
      (reqB.body.note as string).length === 10000,
      `non-skipped path: still truncated to 10000 (got ${(reqB.body.note as string).length})`,
    );

    // (c) Depth guard still applies on a skipped path (DoS protection kept).
    let nextC = false;
    let statusC = 0;
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 1 } } } } } } } } } } };
    const reqC = {
      path: "/api/v1/workshop/modules/x",
      body: deep,
      query: {},
      params: {},
    } as unknown as Request;
    const resC = {
      status: (c: number) => { statusC = c; return resC; },
      json: () => resC,
    } as unknown as Response;
    middleware(reqC, resC, () => { nextC = true; });
    assert(!nextC && statusC === 400, "skipped path: depth guard still rejects >10 levels");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll inputSanitizer tests passed");
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
