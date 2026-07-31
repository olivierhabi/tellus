// ---------------------------------------------------------------------------
// Auto-Create Hook
//
// When a backing datasource is registered for an object type, this hook
// automatically creates the corresponding OpenSearch index. In Palantir's
// architecture, registering a backing datasource triggers index creation
// and the first sync. For Week 1, we only create the index — the user
// must explicitly trigger indexing via the POST /index endpoint (Task 14).
//
// This module is designed to be called from the datasource registration
// endpoint after the datasource record is saved to PostgreSQL. The
// integration point is NOT part of this task — it only provides the hook.
// ---------------------------------------------------------------------------

import { generateIndexMapping } from "../opensearch/indexMappingGenerator";
import { objectTypeIndexName } from "../opensearch/objectIndexNames";
import {
  indexExists,
  createIndex,
  getIndexName,
} from "../opensearch/indexLifecycleManager";
import type { IndexMappingResult } from "../opensearch/indexMappingGenerator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result when the index was successfully created. */
export interface IndexCreatedResult {
  indexCreated: true;
  indexName: string;
}

/** Result when the index already existed. */
export interface IndexAlreadyExistsResult {
  indexCreated: false;
  indexAlreadyExists: true;
  indexName: string;
}

export type AutoCreateResult = IndexCreatedResult | IndexAlreadyExistsResult;

/** Injected dependencies for testing without live services. */
export interface AutoCreateDeps {
  generateIndexMapping: (apiName: string) => Promise<IndexMappingResult>;
  indexExists: (apiName: string) => Promise<{ exists: boolean; indexName: string }>;
  createIndex: (apiName: string) => Promise<{ success: true; indexName: string }>;
  getIndexName: (apiName: string) => string;
}

/** Options for onDatasourceRegistered(). */
export interface AutoCreateOptions {
  /** Injected dependencies for testing. */
  deps?: Partial<AutoCreateDeps>;
}

// ---------------------------------------------------------------------------
// Resolve dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<AutoCreateDeps>): AutoCreateDeps {
  return {
    generateIndexMapping: partial?.generateIndexMapping ?? generateIndexMapping,
    indexExists: partial?.indexExists ?? indexExists,
    createIndex: partial?.createIndex ?? createIndex,
    getIndexName: partial?.getIndexName ?? getIndexName,
  };
}

// ---------------------------------------------------------------------------
// onDatasourceRegistered()
// ---------------------------------------------------------------------------

/**
 * Hook called after a backing datasource is registered for an object type.
 * Creates the OpenSearch index if it doesn't already exist.
 *
 * Does NOT trigger indexing — the user must call the index endpoint
 * explicitly (Task 14) for Week 1.
 *
 * @param objectTypeApiName - The API name of the object type.
 * @param options           - Optional configuration (e.g. injected deps).
 * @returns An AutoCreateResult indicating whether the index was created
 *          or already existed.
 * @throws If the object type has no properties, no primary key, or if
 *         OpenSearch is unreachable and index creation fails.
 */
export async function onDatasourceRegistered(
  objectTypeApiName: string,
  options?: AutoCreateOptions
): Promise<AutoCreateResult> {
  const deps = resolveDeps(options?.deps);

  // -----------------------------------------------------------------------
  // Step 1: Generate the index mapping (validates object type + properties)
  //
  // This validates that the object type exists, has properties, and has a
  // primary key. If any of these checks fail, generateIndexMapping throws
  // and we let it propagate to the caller.
  // -----------------------------------------------------------------------
  await deps.generateIndexMapping(objectTypeApiName);

  // -----------------------------------------------------------------------
  // Step 2: Check if the index already exists
  // -----------------------------------------------------------------------
  const existsResult = await deps.indexExists(objectTypeApiName);

  if (existsResult.exists) {
    console.log(
      `Index '${existsResult.indexName}' already exists for object type '${objectTypeApiName}' — skipping creation`
    );
    return {
      indexCreated: false,
      indexAlreadyExists: true,
      indexName: existsResult.indexName,
    };
  }

  // -----------------------------------------------------------------------
  // Step 3: Create the index
  // -----------------------------------------------------------------------
  try {
    const result = await deps.createIndex(objectTypeApiName);

    console.log(
      `Auto-created index '${result.indexName}' for object type '${objectTypeApiName}'`
    );

    return {
      indexCreated: true,
      indexName: result.indexName,
    };
  } catch (err: unknown) {
    const originalMessage = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to auto-create index for object type '${objectTypeApiName}': ${originalMessage}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { onDatasourceRegistered };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/autoCreateHook.ts)
// ---------------------------------------------------------------------------

export async function runSelfTests(): Promise<void> {
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

  console.log("Running autoCreateHook self-tests...\n");

  // =======================================================================
  // Mock helpers
  // =======================================================================

  const defaultMapping: IndexMappingResult = {
    indexName: "ontology-employee",
    objectTypeApiName: "Employee",
    propertyCount: 4,
    mapping: {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        refresh_interval: "1s",
        max_result_window: 10000,
        analysis: {
          analyzer: {
            default: { type: "standard" },
          },
        },
      },
      mappings: { properties: {} },
    },
    systemFields: ["__pk", "__objectType", "__lastModified", "__version", "__editedBy", "__datasourceVersion"],
    primaryKeyProperty: "employeeId",
    primaryKeyOpenSearchType: "keyword",
  };

  function createMockDeps(overrides?: {
    indexExists?: boolean;
    createFail?: boolean;
    generateFail?: boolean;
  }): AutoCreateDeps {
    const ixExists = overrides?.indexExists ?? false;
    const createFail = overrides?.createFail ?? false;
    const generateFail = overrides?.generateFail ?? false;

    return {
      generateIndexMapping: async (apiName: string) => {
        if (generateFail) {
          throw new Error(`Object type '${apiName}' not found in metadata store`);
        }
        return { ...defaultMapping, objectTypeApiName: apiName, indexName: objectTypeIndexName(apiName) };
      },
      indexExists: async (apiName: string) => ({
        exists: ixExists,
        indexName: objectTypeIndexName(apiName),
      }),
      createIndex: async (apiName: string) => {
        if (createFail) {
          throw new Error("connect ECONNREFUSED 127.0.0.1:9200");
        }
        return {
          success: true as const,
          indexName: objectTypeIndexName(apiName),
        };
      },
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };
  }

  // =======================================================================
  // Test 1: Index does not exist — creates it
  // =======================================================================
  {
    const deps = createMockDeps({ indexExists: false });
    const result = await onDatasourceRegistered("Employee", { deps });

    assert(result.indexCreated === true, "create: indexCreated is true");
    assert(result.indexName === "ontology-employee", "create: indexName correct");
  }

  // =======================================================================
  // Test 2: Index already exists — returns indexAlreadyExists
  // =======================================================================
  {
    const deps = createMockDeps({ indexExists: true });
    const result = await onDatasourceRegistered("Employee", { deps });

    assert(result.indexCreated === false, "exists: indexCreated is false");
    assert(
      "indexAlreadyExists" in result && result.indexAlreadyExists === true,
      "exists: indexAlreadyExists is true"
    );
    assert(result.indexName === "ontology-employee", "exists: indexName correct");
  }

  // =======================================================================
  // Test 3: Object type not found — generateIndexMapping throws
  // =======================================================================
  {
    const deps = createMockDeps({ generateFail: true });

    let threwError = false;
    let errorMsg = "";
    try {
      await onDatasourceRegistered("NonExistent", { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "not found: throws error");
    assert(
      errorMsg.includes("not found in metadata store"),
      `not found: error mentions 'not found' (got: ${errorMsg.substring(0, 60)})`
    );
  }

  // =======================================================================
  // Test 4: OpenSearch unreachable — createIndex fails
  // =======================================================================
  {
    const deps = createMockDeps({ createFail: true });

    let threwError = false;
    let errorMsg = "";
    try {
      await onDatasourceRegistered("Employee", { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError === true, "os fail: throws error");
    assert(
      errorMsg.includes("Failed to auto-create index"),
      `os fail: wrapped error message (got: ${errorMsg.substring(0, 60)})`
    );
    assert(
      errorMsg.includes("ECONNREFUSED"),
      "os fail: includes original error"
    );
  }

  // =======================================================================
  // Test 5: Different object type names produce correct index names
  // =======================================================================
  {
    const deps = createMockDeps();

    const r1 = await onDatasourceRegistered("Taxpayer", { deps });
    assert(r1.indexName === "ontology-taxpayer", "naming: Taxpayer → ontology-taxpayer");

    const r2 = await onDatasourceRegistered("CustomsDeclaration", { deps });
    assert(r2.indexName === "ontology-customsdeclaration", "naming: CustomsDeclaration → ontology-customsdeclaration");

    const r3 = await onDatasourceRegistered("RealEstateProperty", { deps });
    assert(r3.indexName === "ontology-realestateproperty", "naming: RealEstateProperty → ontology-realestateproperty");
  }

  // =======================================================================
  // Test 6: Return types are properly discriminated
  // =======================================================================
  {
    const deps1 = createMockDeps({ indexExists: false });
    const result1 = await onDatasourceRegistered("Employee", { deps: deps1 });

    if (result1.indexCreated) {
      assert("indexName" in result1, "discriminant: created has indexName");
      assert(!("indexAlreadyExists" in result1), "discriminant: created has no indexAlreadyExists");
    }

    const deps2 = createMockDeps({ indexExists: true });
    const result2 = await onDatasourceRegistered("Employee", { deps: deps2 });

    if (!result2.indexCreated) {
      assert("indexAlreadyExists" in result2, "discriminant: exists has indexAlreadyExists");
      assert(result2.indexAlreadyExists === true, "discriminant: indexAlreadyExists true");
    }
  }

  // =======================================================================
  // Test 7: generateIndexMapping is called before indexExists
  //         (validates metadata before touching OpenSearch)
  // =======================================================================
  {
    const callOrder: string[] = [];

    const deps: AutoCreateDeps = {
      generateIndexMapping: async (apiName: string) => {
        callOrder.push("generateIndexMapping");
        return { ...defaultMapping, objectTypeApiName: apiName, indexName: objectTypeIndexName(apiName) };
      },
      indexExists: async (apiName: string) => {
        callOrder.push("indexExists");
        return { exists: false, indexName: objectTypeIndexName(apiName) };
      },
      createIndex: async (apiName: string) => {
        callOrder.push("createIndex");
        return { success: true as const, indexName: objectTypeIndexName(apiName) };
      },
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };

    await onDatasourceRegistered("Employee", { deps });

    assert(callOrder.length === 3, `order: 3 calls made (got ${callOrder.length})`);
    assert(callOrder[0] === "generateIndexMapping", "order: generateIndexMapping first");
    assert(callOrder[1] === "indexExists", "order: indexExists second");
    assert(callOrder[2] === "createIndex", "order: createIndex third");
  }

  // =======================================================================
  // Test 8: When index exists, createIndex is NOT called
  // =======================================================================
  {
    let createCalled = false;

    const deps: AutoCreateDeps = {
      generateIndexMapping: async (apiName: string) => {
        return { ...defaultMapping, objectTypeApiName: apiName, indexName: objectTypeIndexName(apiName) };
      },
      indexExists: async (apiName: string) => ({
        exists: true,
        indexName: objectTypeIndexName(apiName),
      }),
      createIndex: async () => {
        createCalled = true;
        return { success: true as const, indexName: "ontology-employee" };
      },
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };

    await onDatasourceRegistered("Employee", { deps });

    assert(createCalled === false, "skip create: createIndex not called when index exists");
  }

  // =======================================================================
  // Test 9: generateIndexMapping failure prevents indexExists from being called
  // =======================================================================
  {
    let indexExistsCalled = false;

    const deps: AutoCreateDeps = {
      generateIndexMapping: async () => {
        throw new Error("No properties defined");
      },
      indexExists: async (apiName: string) => {
        indexExistsCalled = true;
        return { exists: false, indexName: objectTypeIndexName(apiName) };
      },
      createIndex: async (apiName: string) => ({
        success: true as const,
        indexName: objectTypeIndexName(apiName),
      }),
      getIndexName: (apiName: string) => objectTypeIndexName(apiName),
    };

    try {
      await onDatasourceRegistered("Employee", { deps });
    } catch {
      // expected
    }

    assert(indexExistsCalled === false, "early fail: indexExists not called on generateIndexMapping failure");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll autoCreateHook tests passed");
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
