// ---------------------------------------------------------------------------
// Auto-Index Service
//
// Automatically triggers reindexing when a dataset is modified. When a file
// backing a datasource changes (e.g. new rows added, schema changed), this
// service checks whether an object type is backed by that dataset and, if so,
// triggers a non-blocking reindex.
//
// Design: Failures in auto-indexing do NOT propagate — they are logged and
// returned as a result. This ensures that dataset mutations (the primary
// operation) always succeed even if the downstream reindex fails.
// ---------------------------------------------------------------------------

import { query } from "../db";
import { indexObjectType } from "./indexing/indexingOrchestrator";
import type { IndexObjectTypeResult } from "./indexing/indexingOrchestrator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of checkAndTriggerAutoIndex(). */
export interface AutoIndexResult {
  triggered: boolean;
  reason?: string;
  objectTypeApiName?: string;
  indexResult?: IndexObjectTypeResult;
  error?: string;
}

/** Options for checkAndTriggerAutoIndex(). */
export interface AutoIndexOptions {
  /** If true, force-recreate the OpenSearch index. Default: false. */
  forceRecreateIndex?: boolean;
  /** If true, abort indexing on any validation errors. Default: false. */
  strict?: boolean;
  /** Injected dependencies for testing. */
  deps?: Partial<AutoIndexDeps>;
}

/** Dependency injection interface for testing. */
export interface AutoIndexDeps {
  queryFn: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
  indexObjectType: (
    apiName: string,
    options?: { forceRecreateIndex?: boolean; strict?: boolean }
  ) => Promise<IndexObjectTypeResult>;
}

// ---------------------------------------------------------------------------
// Default dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<AutoIndexDeps>): AutoIndexDeps {
  return {
    queryFn: partial?.queryFn ?? query,
    indexObjectType: partial?.indexObjectType ?? indexObjectType,
  };
}

// ---------------------------------------------------------------------------
// checkAndTriggerAutoIndex()
// ---------------------------------------------------------------------------

/**
 * Check whether a dataset (identified by dataset_id / file path) backs an
 * object type and, if so, trigger a reindex.
 *
 * Steps:
 *   1. Find backing_datasource with this dataset_id (file_path).
 *   2. If none found, return { triggered: false, reason: "no_backing_object_type" }.
 *   3. Get the object type api_name.
 *   4. Call indexObjectType (reindex).
 *   5. Return result — failures do NOT propagate as exceptions.
 *
 * @param datasetId  - The dataset identifier (file path or dataset name).
 * @param options    - Optional configuration.
 * @returns An AutoIndexResult describing what happened.
 */
export async function checkAndTriggerAutoIndex(
  datasetId: string,
  options?: AutoIndexOptions
): Promise<AutoIndexResult> {
  const deps = resolveDeps(options?.deps);
  const forceRecreateIndex = options?.forceRecreateIndex ?? false;
  const strict = options?.strict ?? false;

  try {
    // -----------------------------------------------------------------
    // Step 1: Find backing_datasource by dataset_id, file_path, or dataset_name
    // -----------------------------------------------------------------
    const dsResult = await deps.queryFn(
      `SELECT bd.object_type_id, ot.api_name
       FROM backing_datasource bd
       JOIN object_type ot ON ot.object_type_id = bd.object_type_id
       WHERE bd.dataset_id::text = $1 OR bd.file_path = $1 OR bd.dataset_name = $1
       LIMIT 1`,
      [datasetId]
    );

    // -----------------------------------------------------------------
    // Step 2: No backing object type found
    // -----------------------------------------------------------------
    if (dsResult.rows.length === 0) {
      return {
        triggered: false,
        reason: "no_backing_object_type",
      };
    }

    // -----------------------------------------------------------------
    // Step 3: Get object type api_name
    // -----------------------------------------------------------------
    const objectTypeApiName: string = dsResult.rows[0].api_name;

    // -----------------------------------------------------------------
    // Step 4: Trigger reindex (non-blocking failure handling)
    // -----------------------------------------------------------------
    console.log(
      `Auto-index: triggering reindex for '${objectTypeApiName}' (dataset: '${datasetId}')`
    );

    const indexResult = await deps.indexObjectType(objectTypeApiName, {
      forceRecreateIndex,
      strict,
    });

    // -----------------------------------------------------------------
    // Step 5: Return result
    // -----------------------------------------------------------------
    if (indexResult.success) {
      console.log(
        `Auto-index: reindex succeeded for '${objectTypeApiName}' — ${indexResult.objectsIndexed} objects indexed`
      );
      return {
        triggered: true,
        objectTypeApiName,
        indexResult,
      };
    }

    // Indexing returned a structured failure — this is NOT an exception
    const failureResult = indexResult as import("./indexing/indexingOrchestrator").PipelineFailure;
    console.warn(
      `Auto-index: reindex failed for '${objectTypeApiName}': ${failureResult.error}`
    );
    return {
      triggered: true,
      objectTypeApiName,
      indexResult,
      error: failureResult.error,
    };
  } catch (err) {
    // Unexpected error — log and return failure (do NOT propagate)
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`Auto-index: unexpected error for dataset '${datasetId}': ${errMsg}`);
    return {
      triggered: false,
      reason: "error",
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { checkAndTriggerAutoIndex };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/autoIndexService.ts)
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

  console.log("Running autoIndexService self-tests...\n");

  // =====================================================================
  // Test 1: No backing object type found
  // =====================================================================
  {
    const deps: AutoIndexDeps = {
      queryFn: async () => ({ rows: [] }),
      indexObjectType: async () => {
        throw new Error("Should not be called");
      },
    };

    const result = await checkAndTriggerAutoIndex("/data/unknown.csv", { deps });
    assert(result.triggered === false, "no backing: triggered is false");
    assert(
      result.reason === "no_backing_object_type",
      "no backing: reason is no_backing_object_type"
    );
    assert(result.objectTypeApiName === undefined, "no backing: no apiName");
  }

  // =====================================================================
  // Test 2: Successful auto-index
  // =====================================================================
  {
    const mockIndexResult: IndexObjectTypeResult = {
      success: true,
      objectTypeApiName: "Employee",
      indexName: "ontology-employee",
      pipeline: {
        stage1_metadata: { properties: 4, datasource: "/data/emp.csv" },
        stage2_index: { action: "updated", indexName: "ontology-employee" },
        stage3_read: { rowCount: 10, durationMs: 5 },
        stage4_validate: { uniqueKeys: 10, durationMs: 1 },
        stage5_transform: { validCount: 10, invalidCount: 0, durationMs: 2 },
        stage6_merge: { editsApplied: 0, finalCount: 10, durationMs: 1 },
        stage7_index: { successCount: 10, failedCount: 0, durationMs: 3 },
      },
      totalDurationMs: 12,
      objectsIndexed: 10,
      timestamp: new Date().toISOString(),
    };

    let indexCalled = false;
    const deps: AutoIndexDeps = {
      queryFn: async () => ({
        rows: [{ object_type_id: "ot-1", api_name: "Employee" }],
      }),
      indexObjectType: async (apiName, opts) => {
        indexCalled = true;
        assert(apiName === "Employee", "success: correct apiName passed");
        return mockIndexResult;
      },
    };

    const result = await checkAndTriggerAutoIndex("/data/emp.csv", { deps });
    assert(result.triggered === true, "success: triggered is true");
    assert(indexCalled, "success: indexObjectType was called");
    assert(result.objectTypeApiName === "Employee", "success: apiName is Employee");
    assert(result.indexResult?.success === true, "success: indexResult.success");
    assert(result.error === undefined, "success: no error");
  }

  // =====================================================================
  // Test 3: Indexing returns structured failure (not exception)
  // =====================================================================
  {
    const mockFailResult: IndexObjectTypeResult = {
      success: false,
      objectTypeApiName: "Employee",
      failedAtStage: 3,
      stageName: "Read Datasource",
      error: "File not found: /data/emp.csv",
      totalDurationMs: 5,
      timestamp: new Date().toISOString(),
    };

    const deps: AutoIndexDeps = {
      queryFn: async () => ({
        rows: [{ object_type_id: "ot-1", api_name: "Employee" }],
      }),
      indexObjectType: async () => mockFailResult,
    };

    const result = await checkAndTriggerAutoIndex("/data/emp.csv", { deps });
    assert(result.triggered === true, "index fail: triggered is true");
    assert(result.objectTypeApiName === "Employee", "index fail: apiName");
    assert(result.error === "File not found: /data/emp.csv", "index fail: error message");
    assert(result.indexResult?.success === false, "index fail: indexResult failed");
  }

  // =====================================================================
  // Test 4: indexObjectType throws an exception (unexpected error)
  // =====================================================================
  {
    const deps: AutoIndexDeps = {
      queryFn: async () => ({
        rows: [{ object_type_id: "ot-1", api_name: "Employee" }],
      }),
      indexObjectType: async () => {
        throw new Error("OpenSearch connection refused");
      },
    };

    const result = await checkAndTriggerAutoIndex("/data/emp.csv", { deps });
    assert(result.triggered === false, "exception: triggered is false");
    assert(result.reason === "error", "exception: reason is error");
    assert(
      result.error?.includes("OpenSearch connection refused") === true,
      "exception: error message captured"
    );
  }

  // =====================================================================
  // Test 5: DB query throws (unexpected error)
  // =====================================================================
  {
    const deps: AutoIndexDeps = {
      queryFn: async () => {
        throw new Error("Connection to PostgreSQL refused");
      },
      indexObjectType: async () => {
        throw new Error("Should not be called");
      },
    };

    const result = await checkAndTriggerAutoIndex("/data/emp.csv", { deps });
    assert(result.triggered === false, "db error: triggered is false");
    assert(result.reason === "error", "db error: reason is error");
    assert(
      result.error?.includes("PostgreSQL") === true,
      "db error: error message captured"
    );
  }

  // =====================================================================
  // Test 6: Options forwarded correctly
  // =====================================================================
  {
    let receivedOpts: any = null;

    const deps: AutoIndexDeps = {
      queryFn: async () => ({
        rows: [{ object_type_id: "ot-1", api_name: "Employee" }],
      }),
      indexObjectType: async (apiName, opts) => {
        receivedOpts = opts;
        return {
          success: true,
          objectTypeApiName: apiName,
          indexName: "ontology-employee",
          pipeline: {
            stage1_metadata: { properties: 1, datasource: "/data/x.csv" },
            stage2_index: { action: "created" as const, indexName: "ontology-employee" },
            stage3_read: { rowCount: 0, durationMs: 0 },
            stage4_validate: { uniqueKeys: 0, durationMs: 0 },
            stage5_transform: { validCount: 0, invalidCount: 0, durationMs: 0 },
            stage6_merge: { editsApplied: 0, finalCount: 0, durationMs: 0 },
            stage7_index: { successCount: 0, failedCount: 0, durationMs: 0 },
          },
          totalDurationMs: 0,
          objectsIndexed: 0,
          timestamp: new Date().toISOString(),
        };
      },
    };

    await checkAndTriggerAutoIndex("/data/emp.csv", {
      deps,
      forceRecreateIndex: true,
      strict: true,
    });

    assert(receivedOpts !== null, "opts: options received");
    assert(receivedOpts.forceRecreateIndex === true, "opts: forceRecreateIndex forwarded");
    assert(receivedOpts.strict === true, "opts: strict forwarded");
  }

  // =====================================================================
  // Test 7: Dataset found by dataset_name (not just file_path)
  // =====================================================================
  {
    const deps: AutoIndexDeps = {
      queryFn: async (text, values) => {
        // The query uses OR for file_path and dataset_name
        assert(
          text.includes("dataset_name"),
          "query by name: SQL includes dataset_name"
        );
        return {
          rows: [{ object_type_id: "ot-1", api_name: "Taxpayer" }],
        };
      },
      indexObjectType: async (apiName) => ({
        success: true,
        objectTypeApiName: apiName,
        indexName: "ontology-taxpayer",
        pipeline: {
          stage1_metadata: { properties: 1, datasource: "/data/x.csv" },
          stage2_index: { action: "created" as const, indexName: "ontology-taxpayer" },
          stage3_read: { rowCount: 0, durationMs: 0 },
          stage4_validate: { uniqueKeys: 0, durationMs: 0 },
          stage5_transform: { validCount: 0, invalidCount: 0, durationMs: 0 },
          stage6_merge: { editsApplied: 0, finalCount: 0, durationMs: 0 },
          stage7_index: { successCount: 0, failedCount: 0, durationMs: 0 },
        },
        totalDurationMs: 0,
        objectsIndexed: 0,
        timestamp: new Date().toISOString(),
      }),
    };

    const result = await checkAndTriggerAutoIndex("TaxpayerDataset", { deps });
    assert(result.triggered === true, "by name: triggered");
    assert(result.objectTypeApiName === "Taxpayer", "by name: correct apiName");
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll autoIndexService tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests().catch((err) => {
    console.error("Self-test error:", err);
    process.exit(1);
  });
}
