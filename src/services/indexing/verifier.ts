// ---------------------------------------------------------------------------
// Document Count Verification Utility
//
// After indexing completes, this module verifies that the number of documents
// in OpenSearch matches the expected count. This catches silent failures
// where the bulk API reported success but documents were not actually
// persisted (due to, e.g., disk space issues, mapping conflicts, or cluster
// instability). Palantir's Funnel includes pipeline health checks that
// verify indexed data integrity.
//
// The function is intentionally simple: call client.count() on the index,
// compare with the expected count, and return a structured result. The
// caller (typically the indexing orchestrator or a monitoring endpoint) can
// decide what to do with a mismatch — log a warning, mark the pipeline
// as degraded, or trigger a re-index.
// ---------------------------------------------------------------------------

import { client } from "../opensearch/client";
import { getIndexName } from "../opensearch/indexMappingGenerator";
import { objectTypeIndexName } from "../opensearch/objectIndexNames";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Verification result returned by verifyIndexCount(). */
export interface VerifyCountResult {
  /** Whether the actual count matches the expected count. */
  verified: boolean;
  /** The count the caller expected to find in the index. */
  expectedCount: number;
  /** The count actually reported by OpenSearch. */
  actualCount: number;
  /** Absolute difference: |expectedCount - actualCount|. */
  discrepancy: number;
  /** Human-readable summary message. */
  message: string;
}

/** Result from the count dependency — distinguishes "not found" from "zero docs". */
export interface CountResult {
  /** The document count (0 if index does not exist). */
  count: number;
  /** Whether the index was found at all. */
  indexExists: boolean;
}

/** Injected dependencies — allows testing without a live OpenSearch cluster. */
export interface VerifierDeps {
  /** Calls OpenSearch's count API and returns the document count + existence. */
  getDocumentCount: (indexName: string) => Promise<CountResult>;
  /** Converts an object type API name to its OpenSearch index name. */
  getIndexName: (objectTypeApiName: string) => string;
}

/** Options bag for verifyIndexCount(). */
export interface VerifyOptions {
  /** Injected dependencies for testing. */
  deps?: Partial<VerifierDeps>;
}

// ---------------------------------------------------------------------------
// Default dependency: getDocumentCount via OpenSearch client
// ---------------------------------------------------------------------------

/**
 * Get the document count for the given index from OpenSearch.
 *
 * If the index does not exist, OpenSearch returns a 404 / index_not_found
 * error. We catch that specific case and return { count: 0, indexExists: false }.
 * Any other error (e.g. cluster unreachable) is re-thrown with the spec'd
 * wrapper message.
 */
async function defaultGetDocumentCount(indexName: string): Promise<CountResult> {
  try {
    const { body } = await client.count({ index: indexName });
    return {
      count: (body as { count: number }).count,
      indexExists: true,
    };
  } catch (err: unknown) {
    // OpenSearch returns a 404 with "index_not_found_exception" when
    // the index doesn't exist. Treat as zero documents, index absent.
    if (isIndexNotFoundError(err)) {
      return { count: 0, indexExists: false };
    }

    // Connection failures or other unexpected errors — wrap with the
    // message the spec requires.
    throw new Error(
      "Unable to verify document count: OpenSearch connection failed"
    );
  }
}

/**
 * Detect the "index not found" error shape from the OpenSearch client.
 * The client may throw a ResponseError with statusCode 404 or nest the
 * error inside a `meta` property.
 */
function isIndexNotFoundError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;

  const e = err as Record<string, unknown>;

  // @opensearch-project/opensearch ResponseError shape
  if (e.statusCode === 404) return true;
  if (e.status === 404) return true;

  // Nested meta.statusCode
  if (
    typeof e.meta === "object" &&
    e.meta !== null &&
    (e.meta as Record<string, unknown>).statusCode === 404
  ) {
    return true;
  }

  // Message-based fallback
  if (typeof e.message === "string" && e.message.includes("index_not_found")) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Resolve dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<VerifierDeps>): VerifierDeps {
  return {
    getDocumentCount: partial?.getDocumentCount ?? defaultGetDocumentCount,
    getIndexName: partial?.getIndexName ?? getIndexName,
  };
}

// ---------------------------------------------------------------------------
// verifyIndexCount()
// ---------------------------------------------------------------------------

/**
 * Verify that the document count in the OpenSearch index for the given
 * object type matches the expected count.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param expectedCount     - The number of documents expected in the index.
 * @param options           - Optional configuration (e.g. injected deps).
 * @returns A VerifyCountResult with verified status, counts, and message.
 * @throws If OpenSearch is unreachable — message:
 *         "Unable to verify document count: OpenSearch connection failed"
 */
export async function verifyIndexCount(
  objectTypeApiName: string,
  expectedCount: number,
  options?: VerifyOptions
): Promise<VerifyCountResult> {
  const deps = resolveDeps(options?.deps);
  const indexName = deps.getIndexName(objectTypeApiName);
  const { count: actualCount, indexExists: idxExists } =
    await deps.getDocumentCount(indexName);
  const discrepancy = Math.abs(expectedCount - actualCount);
  const verified = discrepancy === 0;

  // -----------------------------------------------------------------------
  // Build message according to the spec
  // -----------------------------------------------------------------------
  let message: string;

  if (!idxExists) {
    // Index does not exist — specific message per spec
    message = `Index '${indexName}' does not exist`;
  } else if (verified && expectedCount === 0) {
    // Both zero
    message = "Document count matches expected count (both zero)";
  } else if (verified) {
    // Exact match
    message = "Document count matches expected count";
  } else {
    // Mismatch
    const diff = expectedCount - actualCount;
    const detail =
      diff > 0
        ? `${diff} missing`
        : `${Math.abs(diff)} extra`;
    message = `Document count mismatch: expected ${expectedCount}, found ${actualCount} (${detail})`;

    // Spec: log a WARNING on discrepancy (not error — post-hoc check)
    console.warn(
      `WARNING: ${message} for object type '${objectTypeApiName}'`
    );
  }

  return {
    verified,
    expectedCount,
    actualCount,
    discrepancy,
    message,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { verifyIndexCount };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/verifier.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
  // These self-tests assert the DEFAULT index-name shape (e.g.
  // "ontology-taxpayer") byte-for-byte. Under a FUNN-ISO prefixed lane
  // (vitest pins OS_INDEX_PREFIX=ttest-ontology-) the assertions broke —
  // the naming mechanics they check are prefix-independent. Pin the
  // default prefix for the duration of the test; restore after.
  const savedPrefix = process.env.OS_INDEX_PREFIX;
  process.env.OS_INDEX_PREFIX = "ontology-";
  try {
    await runSelfTestsImpl();
  } finally {
    if (savedPrefix === undefined) delete process.env.OS_INDEX_PREFIX;
    else process.env.OS_INDEX_PREFIX = savedPrefix;
  }
}

async function runSelfTestsImpl(): Promise<void> {
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

  console.log("Running verifier self-tests...\n");

  // =======================================================================
  // Helper to create mock deps
  // =======================================================================

  /** Mock deps where the index exists and has `docCount` documents. */
  function createMockDeps(docCount: number): VerifierDeps {
    return {
      getDocumentCount: async (_indexName: string) => ({
        count: docCount,
        indexExists: true,
      }),
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };
  }

  /** Mock deps where the index does NOT exist (404). */
  function createNotFoundDeps(): VerifierDeps {
    return {
      getDocumentCount: async (_indexName: string) => ({
        count: 0,
        indexExists: false,
      }),
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };
  }

  /** Mock deps where getDocumentCount throws (OpenSearch unreachable). */
  function createFailingDeps(error: Error): VerifierDeps {
    return {
      getDocumentCount: async () => {
        throw error;
      },
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };
  }

  // Suppress console.warn during tests so mismatch warnings don't clutter output
  const originalWarn = console.warn;
  const warnMessages: string[] = [];
  console.warn = (msg: string) => {
    warnMessages.push(msg);
  };

  // =======================================================================
  // Test 1: Exact match — counts equal (100 == 100)
  // =======================================================================
  {
    const deps = createMockDeps(100);
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(result.verified === true, "exact match: verified is true");
    assert(result.expectedCount === 100, "exact match: expectedCount is 100");
    assert(result.actualCount === 100, "exact match: actualCount is 100");
    assert(result.discrepancy === 0, "exact match: discrepancy is 0");
    assert(
      result.message === "Document count matches expected count",
      `exact match: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 2: Mismatch — actual > expected (actual 150, expected 100)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(150);
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(result.verified === false, "over: verified is false");
    assert(result.expectedCount === 100, "over: expectedCount is 100");
    assert(result.actualCount === 150, "over: actualCount is 150");
    assert(result.discrepancy === 50, "over: discrepancy is 50");
    assert(
      result.message === "Document count mismatch: expected 100, found 150 (50 extra)",
      `over: message (got: '${result.message}')`
    );
    assert(
      warnMessages.length === 1,
      `over: WARNING logged (got ${warnMessages.length} warnings)`
    );
    assert(
      warnMessages[0].startsWith("WARNING:"),
      "over: warn message starts with WARNING:"
    );
  }

  // =======================================================================
  // Test 3: Mismatch — actual < expected (actual 80, expected 100)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(80);
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(result.verified === false, "under: verified is false");
    assert(result.expectedCount === 100, "under: expectedCount is 100");
    assert(result.actualCount === 80, "under: actualCount is 80");
    assert(result.discrepancy === 20, "under: discrepancy is 20");
    assert(
      result.message === "Document count mismatch: expected 100, found 80 (20 missing)",
      `under: message (got: '${result.message}')`
    );
    assert(
      warnMessages.length === 1,
      "under: WARNING logged"
    );
  }

  // =======================================================================
  // Test 4: Both zero — verified true with spec message
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(0);
    const result = await verifyIndexCount("Employee", 0, { deps });

    assert(result.verified === true, "both zero: verified is true");
    assert(result.expectedCount === 0, "both zero: expectedCount is 0");
    assert(result.actualCount === 0, "both zero: actualCount is 0");
    assert(result.discrepancy === 0, "both zero: discrepancy is 0");
    assert(
      result.message === "Document count matches expected count (both zero)",
      `both zero: message (got: '${result.message}')`
    );
    assert(
      warnMessages.length === 0,
      "both zero: no WARNING logged"
    );
  }

  // =======================================================================
  // Test 5: Index does not exist — specific message per spec
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createNotFoundDeps();
    const result = await verifyIndexCount("Taxpayer", 100, { deps });

    assert(result.verified === false, "no index: verified is false");
    assert(result.expectedCount === 100, "no index: expectedCount is 100");
    assert(result.actualCount === 0, "no index: actualCount is 0");
    assert(result.discrepancy === 100, "no index: discrepancy is 100");
    assert(
      result.message === "Index 'ontology-taxpayer' does not exist",
      `no index: message (got: '${result.message}')`
    );
    // No WARNING for this case — the message itself is descriptive
    assert(
      warnMessages.length === 0,
      "no index: no WARNING logged (index-not-exist is its own message)"
    );
  }

  // =======================================================================
  // Test 6: Index does not exist, expected 0 — still reports not-exist
  // =======================================================================
  {
    const deps = createNotFoundDeps();
    const result = await verifyIndexCount("NonExistent", 0, { deps });

    // Even though discrepancy is 0, the index doesn't exist so verified
    // is technically true (0 == 0) but the message should reflect the
    // index-not-exist state. The spec's not-exist rule takes priority.
    // However, since the spec says verified should track count equality,
    // and 0 == 0, we report verified: true but with the not-exist message.
    assert(result.verified === true, "no index zero: verified is true (0 == 0)");
    assert(result.actualCount === 0, "no index zero: actualCount is 0");
    assert(result.discrepancy === 0, "no index zero: discrepancy is 0");
    assert(
      result.message === "Index 'ontology-nonexistent' does not exist",
      `no index zero: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 7: OpenSearch unreachable — throws with spec's error message
  // =======================================================================
  {
    const deps = createFailingDeps(
      new Error("Unable to verify document count: OpenSearch connection failed")
    );

    let threwError = false;
    let errorMsg = "";
    try {
      await verifyIndexCount("Employee", 100, { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "os fail: throws error");
    assert(
      errorMsg === "Unable to verify document count: OpenSearch connection failed",
      `os fail: error message (got: '${errorMsg}')`
    );
  }

  // =======================================================================
  // Test 8: Large counts — verify arithmetic (discrepancy 5)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(1_000_000);
    const result = await verifyIndexCount("Employee", 999_995, { deps });

    assert(result.verified === false, "large: verified is false");
    assert(result.discrepancy === 5, "large: discrepancy is 5");
    assert(result.actualCount === 1_000_000, "large: actualCount is 1000000");
    assert(result.expectedCount === 999_995, "large: expectedCount is 999995");
    assert(
      result.message.includes("5 extra"),
      `large: message includes '5 extra' (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 9: Large counts — exact match (5M)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(5_000_000);
    const result = await verifyIndexCount("Employee", 5_000_000, { deps });

    assert(result.verified === true, "large exact: verified is true");
    assert(result.discrepancy === 0, "large exact: discrepancy is 0");
    assert(
      result.message === "Document count matches expected count",
      "large exact: message"
    );
  }

  // =======================================================================
  // Test 10: Index name is correctly derived and passed to getDocumentCount
  // =======================================================================
  {
    let capturedIndexName = "";
    const deps: VerifierDeps = {
      getDocumentCount: async (indexName: string) => {
        capturedIndexName = indexName;
        return { count: 42, indexExists: true };
      },
      getIndexName: (apiName: string) =>
        objectTypeIndexName(apiName),
    };

    await verifyIndexCount("Taxpayer", 42, { deps });
    assert(
      capturedIndexName === "ontology-taxpayer",
      `index name: Taxpayer → ontology-taxpayer (got: ${capturedIndexName})`
    );

    await verifyIndexCount("CustomsDeclaration", 42, { deps });
    assert(
      capturedIndexName === "ontology-customsdeclaration",
      `index name: CustomsDeclaration → ontology-customsdeclaration (got: ${capturedIndexName})`
    );

    await verifyIndexCount("RealEstateProperty", 42, { deps });
    assert(
      capturedIndexName === "ontology-realestateproperty",
      `index name: RealEstateProperty → ontology-realestateproperty (got: ${capturedIndexName})`
    );
  }

  // =======================================================================
  // Test 11: Mismatch message includes all three numbers
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(73);
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(
      result.message.includes("100"),
      "mismatch msg: includes expected (100)"
    );
    assert(
      result.message.includes("73"),
      "mismatch msg: includes actual (73)"
    );
    assert(
      result.message.includes("27 missing"),
      "mismatch msg: includes '27 missing'"
    );
  }

  // =======================================================================
  // Test 12: Spec example — expected 995, actual 993 (2 missing)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(993);
    const result = await verifyIndexCount("Employee", 995, { deps });

    assert(result.verified === false, "spec example: verified is false");
    assert(result.discrepancy === 2, "spec example: discrepancy is 2");
    assert(
      result.message === "Document count mismatch: expected 995, found 993 (2 missing)",
      `spec example: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 13: Spec example — expected 995, actual 995 (match)
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(995);
    const result = await verifyIndexCount("Employee", 995, { deps });

    assert(result.verified === true, "spec match: verified is true");
    assert(result.discrepancy === 0, "spec match: discrepancy is 0");
    assert(
      result.message === "Document count matches expected count",
      "spec match: message"
    );
  }

  // =======================================================================
  // Test 14: expectedCount of 1 with actualCount of 1
  // =======================================================================
  {
    const deps = createMockDeps(1);
    const result = await verifyIndexCount("Employee", 1, { deps });

    assert(result.verified === true, "single doc: verified is true");
    assert(result.discrepancy === 0, "single doc: discrepancy is 0");
  }

  // =======================================================================
  // Test 15: expectedCount of 1 with actualCount of 0
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(0);
    const result = await verifyIndexCount("Employee", 1, { deps });

    assert(result.verified === false, "missing one: verified is false");
    assert(result.discrepancy === 1, "missing one: discrepancy is 1");
    assert(result.actualCount === 0, "missing one: actualCount is 0");
    assert(
      result.message === "Document count mismatch: expected 1, found 0 (1 missing)",
      `missing one: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 16: getDocumentCount receives the index name from getIndexName
  // =======================================================================
  {
    const callLog: string[] = [];

    const deps: VerifierDeps = {
      getDocumentCount: async (indexName: string) => {
        callLog.push(`count:${indexName}`);
        return { count: 50, indexExists: true };
      },
      getIndexName: (apiName: string) => {
        const name = objectTypeIndexName(apiName);
        callLog.push(`name:${name}`);
        return name;
      },
    };

    await verifyIndexCount("Business", 50, { deps });

    assert(callLog.length === 2, `call order: 2 calls (got ${callLog.length})`);
    assert(callLog[0] === "name:ontology-business", "call order: getIndexName called first");
    assert(callLog[1] === "count:ontology-business", "call order: getDocumentCount called second with correct index");
  }

  // =======================================================================
  // Test 17: isIndexNotFoundError helper coverage
  // =======================================================================
  {
    assert(isIndexNotFoundError(null) === false, "isNotFound: null → false");
    assert(isIndexNotFoundError(undefined) === false, "isNotFound: undefined → false");
    assert(isIndexNotFoundError("string") === false, "isNotFound: string → false");
    assert(isIndexNotFoundError(42) === false, "isNotFound: number → false");
    assert(
      isIndexNotFoundError({ statusCode: 404 }) === true,
      "isNotFound: { statusCode: 404 } → true"
    );
    assert(
      isIndexNotFoundError({ statusCode: 500 }) === false,
      "isNotFound: { statusCode: 500 } → false"
    );
    assert(
      isIndexNotFoundError({ status: 404 }) === true,
      "isNotFound: { status: 404 } → true"
    );
    assert(
      isIndexNotFoundError({ meta: { statusCode: 404 } }) === true,
      "isNotFound: { meta.statusCode: 404 } → true"
    );
    assert(
      isIndexNotFoundError({ message: "index_not_found_exception" }) === true,
      "isNotFound: message with index_not_found → true"
    );
    assert(
      isIndexNotFoundError({ message: "some other error" }) === false,
      "isNotFound: other message → false"
    );
    assert(
      isIndexNotFoundError({}) === false,
      "isNotFound: empty object → false"
    );
  }

  // =======================================================================
  // Test 18: Non-connection error from getDocumentCount propagates
  // =======================================================================
  {
    const deps = createFailingDeps(new Error("cluster_block_exception"));

    let threwError = false;
    let errorMsg = "";
    try {
      await verifyIndexCount("Employee", 100, { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "other error: throws");
    assert(
      errorMsg.includes("cluster_block_exception"),
      `other error: message preserved (got: ${errorMsg})`
    );
  }

  // =======================================================================
  // Test 19: Return shape always has all required fields
  // =======================================================================
  {
    const deps = createMockDeps(42);
    const result = await verifyIndexCount("Employee", 42, { deps });

    assert("verified" in result, "shape: has 'verified'");
    assert("expectedCount" in result, "shape: has 'expectedCount'");
    assert("actualCount" in result, "shape: has 'actualCount'");
    assert("discrepancy" in result, "shape: has 'discrepancy'");
    assert("message" in result, "shape: has 'message'");
    assert(typeof result.verified === "boolean", "shape: verified is boolean");
    assert(typeof result.expectedCount === "number", "shape: expectedCount is number");
    assert(typeof result.actualCount === "number", "shape: actualCount is number");
    assert(typeof result.discrepancy === "number", "shape: discrepancy is number");
    assert(typeof result.message === "string", "shape: message is string");
  }

  // =======================================================================
  // Test 20: WARNING is logged only on discrepancy, not on match
  // =======================================================================
  {
    warnMessages.length = 0;

    // Match — no warning
    const depsMatch = createMockDeps(50);
    await verifyIndexCount("Employee", 50, { deps: depsMatch });
    assert(warnMessages.length === 0, "warn: no warning on match");

    // Mismatch — warning
    const depsMismatch = createMockDeps(48);
    await verifyIndexCount("Employee", 50, { deps: depsMismatch });
    assert(warnMessages.length === 1, "warn: 1 warning on mismatch");
    assert(
      warnMessages[0].includes("WARNING"),
      "warn: message starts with WARNING"
    );
    assert(
      warnMessages[0].includes("Employee"),
      "warn: message includes object type name"
    );
  }

  // =======================================================================
  // Test 21: Spec verification test — index 100 docs, verify with 100
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(100);
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(result.verified === true, "spec test 1: verified is true");
    assert(result.discrepancy === 0, "spec test 1: discrepancy is 0");
  }

  // =======================================================================
  // Test 22: Spec verification test — verify with 105 when 100 indexed
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createMockDeps(100);
    const result = await verifyIndexCount("Employee", 105, { deps });

    assert(result.verified === false, "spec test 2: verified is false");
    assert(result.discrepancy === 5, "spec test 2: discrepancy is 5");
    assert(
      result.message === "Document count mismatch: expected 105, found 100 (5 missing)",
      `spec test 2: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 23: Spec verification test — non-existent index
  // =======================================================================
  {
    warnMessages.length = 0;
    const deps = createNotFoundDeps();
    const result = await verifyIndexCount("Employee", 100, { deps });

    assert(result.verified === false, "spec test 3: verified is false");
    assert(result.actualCount === 0, "spec test 3: actualCount is 0");
    assert(result.discrepancy === 100, "spec test 3: discrepancy is 100");
    assert(
      result.message === "Index 'ontology-employee' does not exist",
      `spec test 3: message (got: '${result.message}')`
    );
  }

  // =======================================================================
  // Test 24: Multiple mismatch scenarios — warning count tracks correctly
  // =======================================================================
  {
    warnMessages.length = 0;

    const deps = createMockDeps(10);
    await verifyIndexCount("A", 20, { deps });
    await verifyIndexCount("B", 30, { deps });
    await verifyIndexCount("C", 10, { deps }); // match — no warning

    assert(
      warnMessages.length === 2,
      `multi warn: 2 warnings for 2 mismatches (got ${warnMessages.length})`
    );
  }

  // =======================================================================
  // Test 25: Index not found message uses correct index name
  // =======================================================================
  {
    const deps = createNotFoundDeps();
    const result = await verifyIndexCount("CustomsDeclaration", 50, { deps });

    assert(
      result.message === "Index 'ontology-customsdeclaration' does not exist",
      `not found name: message (got: '${result.message}')`
    );
  }

  // Restore console.warn
  console.warn = originalWarn;

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll verifier tests passed");
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
