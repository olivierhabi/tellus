// ---------------------------------------------------------------------------
// Object Count by Type Query
//
// Provides fast count queries across all object types. Used by the status
// dashboard and by the Ontology Manager to show how many objects exist for
// each type.
//
// Two entry points:
//   1. countByObjectType(apiName) — count for a single object type
//   2. countAllObjectTypes()      — counts for every ontology-* index
//
// Both functions use dependency injection so self-tests can run without a
// live OpenSearch cluster or PostgreSQL database.
// ---------------------------------------------------------------------------

import { client } from "./client";
import { getIndexName } from "./indexMappingGenerator";
import { query as dbQuery } from "../../db";
import type { QueryResult } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result when the index exists. */
export interface SingleCountResult {
  apiName: string;
  indexName: string;
  count: number;
}

/** Result when the index does not exist. */
export interface SingleCountNotFound {
  apiName: string;
  indexName: string;
  count: 0;
  exists: false;
}

export type CountByObjectTypeResult = SingleCountResult | SingleCountNotFound;

/** A single entry in the countAllObjectTypes() response. */
export interface ObjectTypeCount {
  apiName: string;
  indexName: string;
  count: number;
  sizeBytes: number;
}

/** Result of countAllObjectTypes(). */
export interface CountAllResult {
  objectTypes: ObjectTypeCount[];
  totalObjects: number;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Shape returned by cat.indices in JSON format. */
export interface CatIndexEntry {
  index: string;
  "docs.count": string;
  "store.size": string;
  /** Size in bytes — may be present as pri.store.size or store.size. */
  [key: string]: unknown;
}

/** Injected dependencies for testing without live services. */
export interface ObjectCounterDeps {
  /** Call client.count() for a single index. Returns the document count. */
  countIndex: (indexName: string) => Promise<number>;
  /** Call client.cat.indices() for the ontology-* pattern. */
  catIndices: () => Promise<CatIndexEntry[]>;
  /** Convert an API name to its OpenSearch index name. */
  getIndexName: (apiName: string) => string;
  /** Query PostgreSQL. */
  dbQuery: (text: string, values?: unknown[]) => Promise<QueryResult>;
}

export interface ObjectCounterOptions {
  deps?: Partial<ObjectCounterDeps>;
}

// ---------------------------------------------------------------------------
// Default implementations for dependencies
// ---------------------------------------------------------------------------

async function defaultCountIndex(indexName: string): Promise<number> {
  const { body } = await client.count({ index: indexName });
  return (body as { count: number }).count;
}

async function defaultCatIndices(): Promise<CatIndexEntry[]> {
  const { body } = await client.cat.indices({
    index: "ontology-*",
    format: "json",
  });
  return body as CatIndexEntry[];
}

// ---------------------------------------------------------------------------
// Resolve dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<ObjectCounterDeps>): ObjectCounterDeps {
  return {
    countIndex: partial?.countIndex ?? defaultCountIndex,
    catIndices: partial?.catIndices ?? defaultCatIndices,
    getIndexName: partial?.getIndexName ?? getIndexName,
    dbQuery: partial?.dbQuery ?? dbQuery,
  };
}

// ---------------------------------------------------------------------------
// Index-not-found detection (same pattern as verifier.ts)
// ---------------------------------------------------------------------------

function isIndexNotFoundError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;

  const e = err as Record<string, unknown>;

  if (e.statusCode === 404) return true;
  if (e.status === 404) return true;

  if (
    typeof e.meta === "object" &&
    e.meta !== null &&
    (e.meta as Record<string, unknown>).statusCode === 404
  ) {
    return true;
  }

  if (typeof e.message === "string" && e.message.includes("index_not_found")) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// countByObjectType()
// ---------------------------------------------------------------------------

/**
 * Return the document count for a single object type's OpenSearch index.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param options           - Optional configuration (e.g. injected deps).
 * @returns The count result, or a not-found result if the index doesn't exist.
 * @throws If OpenSearch is unreachable.
 */
export async function countByObjectType(
  objectTypeApiName: string,
  options?: ObjectCounterOptions
): Promise<CountByObjectTypeResult> {
  const deps = resolveDeps(options?.deps);
  const indexName = deps.getIndexName(objectTypeApiName);

  try {
    const count = await deps.countIndex(indexName);
    return {
      apiName: objectTypeApiName,
      indexName,
      count,
    };
  } catch (err: unknown) {
    if (isIndexNotFoundError(err)) {
      return {
        apiName: objectTypeApiName,
        indexName,
        count: 0,
        exists: false,
      };
    }
    throw new Error(
      `Failed to count documents for '${objectTypeApiName}': OpenSearch is unreachable`
    );
  }
}

// ---------------------------------------------------------------------------
// parseSizeToBytes()
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable size string (e.g. "500kb", "1.2mb", "234b") to bytes.
 * The cat.indices API returns store.size in human-readable format.
 */
function parseSizeToBytes(sizeStr: string | undefined | null): number {
  if (!sizeStr) return 0;

  const str = sizeStr.toLowerCase().trim();
  const match = str.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = match[2] || "b";

  switch (unit) {
    case "b":
      return Math.round(value);
    case "kb":
      return Math.round(value * 1024);
    case "mb":
      return Math.round(value * 1024 * 1024);
    case "gb":
      return Math.round(value * 1024 * 1024 * 1024);
    case "tb":
      return Math.round(value * 1024 * 1024 * 1024 * 1024);
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// countAllObjectTypes()
// ---------------------------------------------------------------------------

/**
 * Query all indices matching the `ontology-*` pattern and return counts for
 * each. Uses cat.indices for the OpenSearch data and queries the object_type
 * table in PostgreSQL to recover the original apiName with correct casing.
 *
 * @param options - Optional configuration (e.g. injected deps).
 * @returns An object with an array of per-type counts and a totalObjects sum.
 * @throws If OpenSearch is unreachable.
 */
export async function countAllObjectTypes(
  options?: ObjectCounterOptions
): Promise<CountAllResult> {
  const deps = resolveDeps(options?.deps);

  // -----------------------------------------------------------------------
  // Step 1: Get all ontology-* indices from OpenSearch
  // -----------------------------------------------------------------------
  let entries: CatIndexEntry[];
  try {
    entries = await deps.catIndices();
  } catch {
    throw new Error(
      "Failed to retrieve object type counts: OpenSearch is unreachable"
    );
  }

  // No indices — return empty
  if (!entries || entries.length === 0) {
    return { objectTypes: [], totalObjects: 0 };
  }

  // -----------------------------------------------------------------------
  // Step 2: Query PostgreSQL for all object types to build a reverse lookup
  //         from lowercased api_name → original api_name.
  // -----------------------------------------------------------------------
  let apiNameLookup: Map<string, string>;
  try {
    const pgResult = await deps.dbQuery(
      "SELECT api_name FROM object_type"
    );
    apiNameLookup = new Map<string, string>();
    for (const row of pgResult.rows) {
      const apiName = row.api_name as string;
      // The index name is ontology-{lowercase api_name}, so the lookup
      // key is the lowercase form.
      apiNameLookup.set(apiName.toLowerCase(), apiName);
    }
  } catch {
    // If PG is down, fall back to index-name-based apiName derivation
    apiNameLookup = new Map<string, string>();
  }

  // -----------------------------------------------------------------------
  // Step 3: Build the result array
  // -----------------------------------------------------------------------
  const objectTypes: ObjectTypeCount[] = [];
  let totalObjects = 0;

  for (const entry of entries) {
    const indexName = entry.index;
    const count = parseInt(String(entry["docs.count"]) || "0", 10) || 0;
    const sizeStr = (entry["store.size"] as string) || "0b";
    const sizeBytes = parseSizeToBytes(sizeStr);

    // Strip "ontology-" prefix to get the lowercased name
    const stripped = indexName.startsWith("ontology-")
      ? indexName.slice("ontology-".length)
      : indexName;

    // Look up original casing from PG, fall back to stripped name
    const apiName = apiNameLookup.get(stripped) || stripped;

    objectTypes.push({ apiName, indexName, count, sizeBytes });
    totalObjects += count;
  }

  return { objectTypes, totalObjects };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { countByObjectType, countAllObjectTypes };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/opensearch/objectCounter.ts)
// ---------------------------------------------------------------------------

async function runSelfTests(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running objectCounter self-tests...\n");

  // =======================================================================
  // Helper: mock deps
  // =======================================================================

  function mockGetIndexName(apiName: string): string {
    return `ontology-${apiName.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  }

  function createSingleDeps(
    countMap: Record<string, number>,
    notFoundIndices?: Set<string>
  ): Partial<ObjectCounterDeps> {
    const nf = notFoundIndices ?? new Set<string>();
    return {
      countIndex: async (indexName: string) => {
        if (nf.has(indexName)) {
          const err = new Error("index_not_found_exception") as Error & { statusCode: number };
          err.statusCode = 404;
          throw err;
        }
        if (indexName in countMap) return countMap[indexName];
        throw new Error("connect ECONNREFUSED");
      },
      getIndexName: mockGetIndexName,
    };
  }

  function createAllDeps(
    entries: CatIndexEntry[],
    pgRows: Array<{ api_name: string }>,
    catFail?: boolean,
    pgFail?: boolean
  ): Partial<ObjectCounterDeps> {
    return {
      catIndices: async () => {
        if (catFail) throw new Error("connect ECONNREFUSED");
        return entries;
      },
      dbQuery: async () => {
        if (pgFail) throw new Error("pg connection failed");
        return { rows: pgRows, command: "", rowCount: pgRows.length, oid: 0, fields: [] } as unknown as QueryResult;
      },
      getIndexName: mockGetIndexName,
    };
  }

  // =======================================================================
  // countByObjectType tests
  // =======================================================================

  // --- Test 1: Index exists with documents ---
  {
    const deps = createSingleDeps({ "ontology-employee": 1000 });
    const result = await countByObjectType("Employee", { deps });

    assert(result.apiName === "Employee", "single exists: apiName");
    assert(result.indexName === "ontology-employee", "single exists: indexName");
    assert(result.count === 1000, "single exists: count is 1000");
    assert(!("exists" in result), "single exists: no 'exists' field");
  }

  // --- Test 2: Index exists with zero documents ---
  {
    const deps = createSingleDeps({ "ontology-employee": 0 });
    const result = await countByObjectType("Employee", { deps });

    assert(result.count === 0, "single zero: count is 0");
    assert(!("exists" in result), "single zero: no 'exists' field (index exists, just empty)");
  }

  // --- Test 3: Index does not exist ---
  {
    const deps = createSingleDeps({}, new Set(["ontology-nonexistent"]));
    const result = await countByObjectType("NonExistent", { deps });

    assert(result.apiName === "NonExistent", "not found: apiName");
    assert(result.indexName === "ontology-nonexistent", "not found: indexName");
    assert(result.count === 0, "not found: count is 0");
    assert("exists" in result && (result as SingleCountNotFound).exists === false, "not found: exists is false");
  }

  // --- Test 4: OpenSearch unreachable ---
  {
    const deps: Partial<ObjectCounterDeps> = {
      countIndex: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      getIndexName: mockGetIndexName,
    };

    let threwError = false;
    let errorMsg = "";
    try {
      await countByObjectType("Employee", { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError, "os fail: throws");
    assert(
      errorMsg.includes("OpenSearch is unreachable"),
      `os fail: message (got: '${errorMsg}')`
    );
    assert(
      errorMsg.includes("Employee"),
      "os fail: message includes apiName"
    );
  }

  // --- Test 5: Different object type names ---
  {
    const deps = createSingleDeps({
      "ontology-taxpayer": 500,
      "ontology-customsdeclaration": 200,
      "ontology-realestateproperty": 75,
    });

    const r1 = await countByObjectType("Taxpayer", { deps });
    assert(r1.count === 500, "names: Taxpayer count");
    assert(r1.indexName === "ontology-taxpayer", "names: Taxpayer indexName");

    const r2 = await countByObjectType("CustomsDeclaration", { deps });
    assert(r2.count === 200, "names: CustomsDeclaration count");

    const r3 = await countByObjectType("RealEstateProperty", { deps });
    assert(r3.count === 75, "names: RealEstateProperty count");
  }

  // --- Test 6: Large document count ---
  {
    const deps = createSingleDeps({ "ontology-employee": 10_000_000 });
    const result = await countByObjectType("Employee", { deps });

    assert(result.count === 10_000_000, "large count: 10M");
  }

  // --- Test 7: Index name passed to countIndex matches getIndexName ---
  {
    let capturedIndex = "";
    const deps: Partial<ObjectCounterDeps> = {
      countIndex: async (indexName: string) => {
        capturedIndex = indexName;
        return 42;
      },
      getIndexName: mockGetIndexName,
    };

    await countByObjectType("TaxReturn", { deps });
    assert(
      capturedIndex === "ontology-taxreturn",
      `index passthrough: (got: '${capturedIndex}')`
    );
  }

  // =======================================================================
  // countAllObjectTypes tests
  // =======================================================================

  // --- Test 8: Two object types ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-employee", "docs.count": "1000", "store.size": "500kb" },
      { index: "ontology-company", "docs.count": "50", "store.size": "25kb" },
    ];
    const pgRows = [
      { api_name: "Employee" },
      { api_name: "Company" },
    ];
    const deps = createAllDeps(entries, pgRows);
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes.length === 2, "all two: 2 entries");
    assert(result.totalObjects === 1050, "all two: totalObjects is 1050");

    const emp = result.objectTypes.find((o) => o.indexName === "ontology-employee");
    assert(emp !== undefined, "all two: Employee found");
    assert(emp!.apiName === "Employee", "all two: Employee apiName casing");
    assert(emp!.count === 1000, "all two: Employee count");
    assert(emp!.sizeBytes === 500 * 1024, "all two: Employee sizeBytes");

    const co = result.objectTypes.find((o) => o.indexName === "ontology-company");
    assert(co !== undefined, "all two: Company found");
    assert(co!.apiName === "Company", "all two: Company apiName casing");
    assert(co!.count === 50, "all two: Company count");
    assert(co!.sizeBytes === 25 * 1024, "all two: Company sizeBytes");
  }

  // --- Test 9: No ontology-* indices ---
  {
    const deps = createAllDeps([], []);
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes.length === 0, "all empty: 0 entries");
    assert(result.totalObjects === 0, "all empty: totalObjects is 0");
  }

  // --- Test 10: OpenSearch unreachable ---
  {
    const deps = createAllDeps([], [], true);

    let threwError = false;
    let errorMsg = "";
    try {
      await countAllObjectTypes({ deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError, "all os fail: throws");
    assert(
      errorMsg.includes("OpenSearch is unreachable"),
      `all os fail: message (got: '${errorMsg}')`
    );
  }

  // --- Test 11: PG fallback — index name stripped as apiName ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-employee", "docs.count": "100", "store.size": "10kb" },
    ];
    const deps = createAllDeps(entries, [], false, true); // PG fails
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes.length === 1, "pg fallback: 1 entry");
    // When PG is down, apiName falls back to stripped index name (no casing)
    assert(
      result.objectTypes[0].apiName === "employee",
      `pg fallback: apiName is stripped (got: '${result.objectTypes[0].apiName}')`
    );
    assert(result.objectTypes[0].count === 100, "pg fallback: count");
  }

  // --- Test 12: PG has the object type but index name has different casing ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-customsdeclaration", "docs.count": "300", "store.size": "150kb" },
    ];
    const pgRows = [
      { api_name: "CustomsDeclaration" },
    ];
    const deps = createAllDeps(entries, pgRows);
    const result = await countAllObjectTypes({ deps });

    assert(
      result.objectTypes[0].apiName === "CustomsDeclaration",
      `casing: apiName restored to 'CustomsDeclaration' (got: '${result.objectTypes[0].apiName}')`
    );
  }

  // --- Test 13: Index with no matching PG entry — uses stripped name ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-orphan", "docs.count": "10", "store.size": "5kb" },
    ];
    const pgRows = [
      { api_name: "Employee" }, // doesn't match "orphan"
    ];
    const deps = createAllDeps(entries, pgRows);
    const result = await countAllObjectTypes({ deps });

    assert(
      result.objectTypes[0].apiName === "orphan",
      `orphan: apiName is 'orphan' (got: '${result.objectTypes[0].apiName}')`
    );
  }

  // --- Test 14: parseSizeToBytes — various formats ---
  {
    assert(parseSizeToBytes("500kb") === 500 * 1024, "parseSize: 500kb");
    assert(parseSizeToBytes("1mb") === 1024 * 1024, "parseSize: 1mb");
    assert(parseSizeToBytes("1.5mb") === Math.round(1.5 * 1024 * 1024), "parseSize: 1.5mb");
    assert(parseSizeToBytes("234b") === 234, "parseSize: 234b");
    assert(parseSizeToBytes("2gb") === 2 * 1024 * 1024 * 1024, "parseSize: 2gb");
    assert(parseSizeToBytes("1tb") === 1024 * 1024 * 1024 * 1024, "parseSize: 1tb");
    assert(parseSizeToBytes("0b") === 0, "parseSize: 0b");
    assert(parseSizeToBytes("") === 0, "parseSize: empty string");
    assert(parseSizeToBytes(null as unknown as string) === 0, "parseSize: null");
    assert(parseSizeToBytes(undefined as unknown as string) === 0, "parseSize: undefined");
    assert(parseSizeToBytes("abc") === 0, "parseSize: non-numeric");
    assert(parseSizeToBytes("100") === 100, "parseSize: no unit defaults to bytes");
  }

  // --- Test 15: totalObjects is sum of all counts ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-a", "docs.count": "100", "store.size": "10kb" },
      { index: "ontology-b", "docs.count": "200", "store.size": "20kb" },
      { index: "ontology-c", "docs.count": "300", "store.size": "30kb" },
    ];
    const pgRows = [
      { api_name: "A" },
      { api_name: "B" },
      { api_name: "C" },
    ];
    const deps = createAllDeps(entries, pgRows);
    const result = await countAllObjectTypes({ deps });

    assert(result.totalObjects === 600, "total sum: 600");
    assert(result.objectTypes.length === 3, "total sum: 3 entries");
  }

  // --- Test 16: cat.indices returns null/undefined body gracefully ---
  {
    const deps: Partial<ObjectCounterDeps> = {
      catIndices: async () => [] as CatIndexEntry[],
      dbQuery: async () => ({ rows: [], command: "", rowCount: 0, oid: 0, fields: [] } as unknown as QueryResult),
      getIndexName: mockGetIndexName,
    };
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes.length === 0, "null body: 0 entries");
    assert(result.totalObjects === 0, "null body: totalObjects is 0");
  }

  // --- Test 17: docs.count as non-numeric string defaults to 0 ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-test", "docs.count": "N/A", "store.size": "0b" },
    ];
    const deps = createAllDeps(entries, []);
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes[0].count === 0, "nan count: defaults to 0");
  }

  // --- Test 18: isIndexNotFoundError detection patterns ---
  {
    assert(isIndexNotFoundError(null) === false, "isNotFound: null");
    assert(isIndexNotFoundError(undefined) === false, "isNotFound: undefined");
    assert(isIndexNotFoundError({ statusCode: 404 }) === true, "isNotFound: statusCode 404");
    assert(isIndexNotFoundError({ statusCode: 500 }) === false, "isNotFound: statusCode 500");
    assert(isIndexNotFoundError({ status: 404 }) === true, "isNotFound: status 404");
    assert(isIndexNotFoundError({ meta: { statusCode: 404 } }) === true, "isNotFound: meta.statusCode 404");
    assert(isIndexNotFoundError({ message: "index_not_found_exception" }) === true, "isNotFound: message");
    assert(isIndexNotFoundError({}) === false, "isNotFound: empty obj");
  }

  // --- Test 19: countByObjectType return shape for existing index ---
  {
    const deps = createSingleDeps({ "ontology-employee": 42 });
    const result = await countByObjectType("Employee", { deps });

    assert("apiName" in result, "shape exists: has apiName");
    assert("indexName" in result, "shape exists: has indexName");
    assert("count" in result, "shape exists: has count");
    assert(!("exists" in result), "shape exists: no 'exists' field");
  }

  // --- Test 20: countByObjectType return shape for not-found index ---
  {
    const deps = createSingleDeps({}, new Set(["ontology-missing"]));
    const result = await countByObjectType("Missing", { deps });

    assert("apiName" in result, "shape not found: has apiName");
    assert("indexName" in result, "shape not found: has indexName");
    assert("count" in result, "shape not found: has count");
    assert("exists" in result, "shape not found: has exists");
    assert((result as SingleCountNotFound).exists === false, "shape not found: exists is false");
  }

  // --- Test 21: countAllObjectTypes return shape ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-x", "docs.count": "5", "store.size": "1kb" },
    ];
    const deps = createAllDeps(entries, [{ api_name: "X" }]);
    const result = await countAllObjectTypes({ deps });

    assert("objectTypes" in result, "shape all: has objectTypes");
    assert("totalObjects" in result, "shape all: has totalObjects");
    assert(Array.isArray(result.objectTypes), "shape all: objectTypes is array");

    const item = result.objectTypes[0];
    assert("apiName" in item, "shape all item: has apiName");
    assert("indexName" in item, "shape all item: has indexName");
    assert("count" in item, "shape all item: has count");
    assert("sizeBytes" in item, "shape all item: has sizeBytes");
  }

  // --- Test 22: Multiple PG rows, only some match indices ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-employee", "docs.count": "100", "store.size": "50kb" },
    ];
    const pgRows = [
      { api_name: "Employee" },
      { api_name: "Company" },
      { api_name: "Taxpayer" },
    ];
    const deps = createAllDeps(entries, pgRows);
    const result = await countAllObjectTypes({ deps });

    // Only 1 index, so only 1 result — but Employee should have correct casing
    assert(result.objectTypes.length === 1, "partial match: 1 entry");
    assert(result.objectTypes[0].apiName === "Employee", "partial match: Employee casing");
  }

  // --- Test 23: Index with store.size in mb ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-big", "docs.count": "50000", "store.size": "2.5mb" },
    ];
    const deps = createAllDeps(entries, [{ api_name: "Big" }]);
    const result = await countAllObjectTypes({ deps });

    assert(result.objectTypes[0].count === 50000, "mb size: count");
    assert(
      result.objectTypes[0].sizeBytes === Math.round(2.5 * 1024 * 1024),
      `mb size: sizeBytes (got: ${result.objectTypes[0].sizeBytes})`
    );
  }

  // --- Test 24: Spec verification test — two types, verify totals ---
  {
    const entries: CatIndexEntry[] = [
      { index: "ontology-employee", "docs.count": "1000", "store.size": "500kb" },
      { index: "ontology-company", "docs.count": "50", "store.size": "25kb" },
    ];
    const pgRows = [
      { api_name: "Employee" },
      { api_name: "Company" },
    ];

    // countByObjectType for each
    const singleDeps = createSingleDeps({
      "ontology-employee": 1000,
      "ontology-company": 50,
    });

    const empCount = await countByObjectType("Employee", { deps: singleDeps });
    assert(empCount.count === 1000, "spec: Employee count 1000");

    const coCount = await countByObjectType("Company", { deps: singleDeps });
    assert(coCount.count === 50, "spec: Company count 50");

    // countAllObjectTypes
    const allDeps = createAllDeps(entries, pgRows);
    const allResult = await countAllObjectTypes({ deps: allDeps });
    assert(allResult.objectTypes.length === 2, "spec: 2 types");
    assert(allResult.totalObjects === 1050, "spec: totalObjects 1050");
  }

  // --- Test 25: Spec verification test — non-existent type ---
  {
    const deps = createSingleDeps({}, new Set(["ontology-nonexistent"]));
    const result = await countByObjectType("NonExistent", { deps });

    assert(result.count === 0, "spec not found: count is 0");
    assert("exists" in result, "spec not found: has exists field");
    assert((result as SingleCountNotFound).exists === false, "spec not found: exists is false");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll objectCounter tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
