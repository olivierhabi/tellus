// ---------------------------------------------------------------------------
// Index Refresh Utility
//
// Provides explicit index refresh control for OpenSearch. During bulk
// indexing, disabling auto-refresh and performing a manual refresh after
// completion can improve performance by 20-30%. OpenSearch's default
// refresh_interval is 1 second, which causes frequent segment merges that
// slow down bulk writes.
//
// Usage pattern for bulk indexing:
//   1. disableAutoRefresh(indexName)   — pause auto-refresh
//   2. ... bulk index documents ...
//   3. enableAutoRefresh(indexName)    — restore 1s refresh interval
//   4. refreshNow(indexName)           — force immediate refresh to make
//                                        documents searchable
//
// Note: Integration with bulkIndex() (Task 10) is tracked separately.
// ---------------------------------------------------------------------------

import { client } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of disableAutoRefresh() or enableAutoRefresh(). */
export interface RefreshSettingResult {
  success: true;
  indexName: string;
  refreshInterval: string;
}

/** Result of refreshNow(). */
export interface RefreshNowResult {
  success: true;
  indexName: string;
}

/** Result of refreshAll(). */
export interface RefreshAllResult {
  success: true;
  pattern: string;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/** Injected dependencies for testing without a live OpenSearch cluster. */
export interface RefreshUtilDeps {
  /** Call client.indices.putSettings(). */
  putSettings: (indexName: string, body: Record<string, unknown>) => Promise<void>;
  /** Call client.indices.refresh() for a single index or pattern. */
  refresh: (indexOrPattern: string) => Promise<void>;
}

export interface RefreshUtilOptions {
  deps?: Partial<RefreshUtilDeps>;
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

async function defaultPutSettings(
  indexName: string,
  body: Record<string, unknown>
): Promise<void> {
  await client.indices.putSettings({ index: indexName, body });
}

async function defaultRefresh(indexOrPattern: string): Promise<void> {
  await client.indices.refresh({ index: indexOrPattern });
}

// ---------------------------------------------------------------------------
// Resolve dependencies
// ---------------------------------------------------------------------------

function resolveDeps(partial?: Partial<RefreshUtilDeps>): RefreshUtilDeps {
  return {
    putSettings: partial?.putSettings ?? defaultPutSettings,
    refresh: partial?.refresh ?? defaultRefresh,
  };
}

// ---------------------------------------------------------------------------
// disableAutoRefresh()
// ---------------------------------------------------------------------------

/**
 * Disable automatic index refresh by setting `refresh_interval` to `"-1"`.
 * This should be called before bulk indexing operations to prevent frequent
 * segment merges.
 *
 * @param indexName - The OpenSearch index name.
 * @param options   - Optional configuration (e.g. injected deps).
 * @returns A result with the new refresh interval.
 * @throws If OpenSearch is unreachable or the index does not exist.
 */
export async function disableAutoRefresh(
  indexName: string,
  options?: RefreshUtilOptions
): Promise<RefreshSettingResult> {
  const deps = resolveDeps(options?.deps);

  await deps.putSettings(indexName, {
    index: { refresh_interval: "-1" },
  });

  return {
    success: true,
    indexName,
    refreshInterval: "-1",
  };
}

// ---------------------------------------------------------------------------
// enableAutoRefresh()
// ---------------------------------------------------------------------------

/**
 * Enable automatic index refresh by setting `refresh_interval` to the
 * given interval (default: `"1s"`). Call this after bulk indexing completes
 * to restore normal refresh behavior.
 *
 * @param indexName - The OpenSearch index name.
 * @param interval  - The refresh interval (default: `"1s"`).
 * @param options   - Optional configuration (e.g. injected deps).
 * @returns A result with the new refresh interval.
 * @throws If OpenSearch is unreachable or the index does not exist.
 */
export async function enableAutoRefresh(
  indexName: string,
  interval: string = "1s",
  options?: RefreshUtilOptions
): Promise<RefreshSettingResult> {
  const deps = resolveDeps(options?.deps);

  await deps.putSettings(indexName, {
    index: { refresh_interval: interval },
  });

  return {
    success: true,
    indexName,
    refreshInterval: interval,
  };
}

// ---------------------------------------------------------------------------
// refreshNow()
// ---------------------------------------------------------------------------

/**
 * Force an immediate refresh on a single index, making all recently indexed
 * documents searchable.
 *
 * @param indexName - The OpenSearch index name.
 * @param options   - Optional configuration (e.g. injected deps).
 * @returns A success result.
 * @throws If OpenSearch is unreachable or the index does not exist.
 */
export async function refreshNow(
  indexName: string,
  options?: RefreshUtilOptions
): Promise<RefreshNowResult> {
  const deps = resolveDeps(options?.deps);

  await deps.refresh(indexName);

  return {
    success: true,
    indexName,
  };
}

// ---------------------------------------------------------------------------
// refreshAll()
// ---------------------------------------------------------------------------

/**
 * Refresh all `ontology-*` indices at once. Useful after a batch operation
 * that touches multiple object types.
 *
 * @param options - Optional configuration (e.g. injected deps).
 * @returns A success result with the pattern used.
 * @throws If OpenSearch is unreachable.
 */
export async function refreshAll(
  options?: RefreshUtilOptions
): Promise<RefreshAllResult> {
  const deps = resolveDeps(options?.deps);

  await deps.refresh("ontology-*");

  return {
    success: true,
    pattern: "ontology-*",
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default { disableAutoRefresh, enableAutoRefresh, refreshNow, refreshAll };

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/opensearch/refreshUtil.ts)
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

  console.log("Running refreshUtil self-tests...\n");

  // =======================================================================
  // Mock helpers
  // =======================================================================

  interface PutSettingsCall {
    indexName: string;
    body: Record<string, unknown>;
  }

  interface RefreshCall {
    indexOrPattern: string;
  }

  function createMockDeps(opts?: {
    putSettingsFail?: boolean;
    refreshFail?: boolean;
  }): {
    deps: RefreshUtilDeps;
    putSettingsCalls: PutSettingsCall[];
    refreshCalls: RefreshCall[];
  } {
    const putSettingsCalls: PutSettingsCall[] = [];
    const refreshCalls: RefreshCall[] = [];

    return {
      deps: {
        putSettings: async (indexName, body) => {
          if (opts?.putSettingsFail) {
            throw new Error("connect ECONNREFUSED 127.0.0.1:9200");
          }
          putSettingsCalls.push({ indexName, body });
        },
        refresh: async (indexOrPattern) => {
          if (opts?.refreshFail) {
            throw new Error("connect ECONNREFUSED 127.0.0.1:9200");
          }
          refreshCalls.push({ indexOrPattern });
        },
      },
      putSettingsCalls,
      refreshCalls,
    };
  }

  // =======================================================================
  // disableAutoRefresh tests
  // =======================================================================

  // --- Test 1: Returns correct result ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    const result = await disableAutoRefresh("ontology-employee", { deps });

    assert(result.success === true, "disable: success is true");
    assert(result.indexName === "ontology-employee", "disable: indexName");
    assert(result.refreshInterval === "-1", "disable: refreshInterval is '-1'");
    assert(putSettingsCalls.length === 1, "disable: 1 putSettings call");
  }

  // --- Test 2: Passes correct body to putSettings ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    await disableAutoRefresh("ontology-taxpayer", { deps });

    const call = putSettingsCalls[0];
    assert(call.indexName === "ontology-taxpayer", "disable body: correct index");

    const idx = (call.body as { index: { refresh_interval: string } }).index;
    assert(idx.refresh_interval === "-1", "disable body: refresh_interval is '-1'");
  }

  // --- Test 3: Throws when OpenSearch is unreachable ---
  {
    const { deps } = createMockDeps({ putSettingsFail: true });

    let threwError = false;
    let errorMsg = "";
    try {
      await disableAutoRefresh("ontology-employee", { deps });
    } catch (err) {
      threwError = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    assert(threwError, "disable fail: throws");
    assert(errorMsg.includes("ECONNREFUSED"), "disable fail: error message");
  }

  // =======================================================================
  // enableAutoRefresh tests
  // =======================================================================

  // --- Test 4: Default interval is "1s" ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    const result = await enableAutoRefresh("ontology-employee", undefined, { deps });

    assert(result.success === true, "enable default: success");
    assert(result.indexName === "ontology-employee", "enable default: indexName");
    assert(result.refreshInterval === "1s", "enable default: refreshInterval is '1s'");

    const body = putSettingsCalls[0].body as { index: { refresh_interval: string } };
    assert(body.index.refresh_interval === "1s", "enable default: putSettings body '1s'");
  }

  // --- Test 5: Custom interval ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    const result = await enableAutoRefresh("ontology-employee", "5s", { deps });

    assert(result.refreshInterval === "5s", "enable custom: refreshInterval is '5s'");

    const body = putSettingsCalls[0].body as { index: { refresh_interval: string } };
    assert(body.index.refresh_interval === "5s", "enable custom: putSettings body '5s'");
  }

  // --- Test 6: Another custom interval ---
  {
    const { deps } = createMockDeps();
    const result = await enableAutoRefresh("ontology-employee", "30s", { deps });

    assert(result.refreshInterval === "30s", "enable 30s: refreshInterval");
  }

  // --- Test 7: Throws when OpenSearch is unreachable ---
  {
    const { deps } = createMockDeps({ putSettingsFail: true });

    let threwError = false;
    try {
      await enableAutoRefresh("ontology-employee", "1s", { deps });
    } catch {
      threwError = true;
    }

    assert(threwError, "enable fail: throws");
  }

  // =======================================================================
  // refreshNow tests
  // =======================================================================

  // --- Test 8: Returns correct result ---
  {
    const { deps, refreshCalls } = createMockDeps();
    const result = await refreshNow("ontology-employee", { deps });

    assert(result.success === true, "refreshNow: success is true");
    assert(result.indexName === "ontology-employee", "refreshNow: indexName");
    assert(refreshCalls.length === 1, "refreshNow: 1 refresh call");
    assert(
      refreshCalls[0].indexOrPattern === "ontology-employee",
      "refreshNow: correct index passed"
    );
  }

  // --- Test 9: Different index names ---
  {
    const { deps, refreshCalls } = createMockDeps();
    await refreshNow("ontology-taxpayer", { deps });

    assert(
      refreshCalls[0].indexOrPattern === "ontology-taxpayer",
      "refreshNow taxpayer: correct index"
    );
  }

  // --- Test 10: Throws when OpenSearch is unreachable ---
  {
    const { deps } = createMockDeps({ refreshFail: true });

    let threwError = false;
    try {
      await refreshNow("ontology-employee", { deps });
    } catch {
      threwError = true;
    }

    assert(threwError, "refreshNow fail: throws");
  }

  // =======================================================================
  // refreshAll tests
  // =======================================================================

  // --- Test 11: Returns correct result ---
  {
    const { deps, refreshCalls } = createMockDeps();
    const result = await refreshAll({ deps });

    assert(result.success === true, "refreshAll: success is true");
    assert(result.pattern === "ontology-*", "refreshAll: pattern is 'ontology-*'");
    assert(refreshCalls.length === 1, "refreshAll: 1 refresh call");
    assert(
      refreshCalls[0].indexOrPattern === "ontology-*",
      "refreshAll: correct pattern passed"
    );
  }

  // --- Test 12: Throws when OpenSearch is unreachable ---
  {
    const { deps } = createMockDeps({ refreshFail: true });

    let threwError = false;
    try {
      await refreshAll({ deps });
    } catch {
      threwError = true;
    }

    assert(threwError, "refreshAll fail: throws");
  }

  // =======================================================================
  // Integration-style flow tests
  // =======================================================================

  // --- Test 13: Full disable → enable → refresh flow ---
  {
    const { deps, putSettingsCalls, refreshCalls } = createMockDeps();

    const r1 = await disableAutoRefresh("ontology-employee", { deps });
    assert(r1.refreshInterval === "-1", "flow: disabled");

    const r2 = await enableAutoRefresh("ontology-employee", "1s", { deps });
    assert(r2.refreshInterval === "1s", "flow: enabled");

    const r3 = await refreshNow("ontology-employee", { deps });
    assert(r3.success === true, "flow: refreshed");

    assert(putSettingsCalls.length === 2, "flow: 2 putSettings calls (disable + enable)");
    assert(refreshCalls.length === 1, "flow: 1 refresh call");

    // Verify call order
    assert(
      putSettingsCalls[0].body.index !== undefined,
      "flow: first putSettings has index body"
    );
    const firstInterval = (
      putSettingsCalls[0].body as { index: { refresh_interval: string } }
    ).index.refresh_interval;
    assert(firstInterval === "-1", "flow: first call disables (-1)");

    const secondInterval = (
      putSettingsCalls[1].body as { index: { refresh_interval: string } }
    ).index.refresh_interval;
    assert(secondInterval === "1s", "flow: second call enables (1s)");
  }

  // --- Test 14: Multiple indices ---
  {
    const { deps, putSettingsCalls, refreshCalls } = createMockDeps();

    await disableAutoRefresh("ontology-employee", { deps });
    await disableAutoRefresh("ontology-company", { deps });
    await enableAutoRefresh("ontology-employee", undefined, { deps });
    await enableAutoRefresh("ontology-company", undefined, { deps });
    await refreshAll({ deps });

    assert(putSettingsCalls.length === 4, "multi: 4 putSettings calls");
    assert(putSettingsCalls[0].indexName === "ontology-employee", "multi: call 1 employee");
    assert(putSettingsCalls[1].indexName === "ontology-company", "multi: call 2 company");
    assert(putSettingsCalls[2].indexName === "ontology-employee", "multi: call 3 employee");
    assert(putSettingsCalls[3].indexName === "ontology-company", "multi: call 4 company");
    assert(refreshCalls.length === 1, "multi: 1 refreshAll call");
    assert(refreshCalls[0].indexOrPattern === "ontology-*", "multi: refreshAll pattern");
  }

  // =======================================================================
  // Return shape tests
  // =======================================================================

  // --- Test 15: disableAutoRefresh shape ---
  {
    const { deps } = createMockDeps();
    const result = await disableAutoRefresh("ontology-x", { deps });

    assert("success" in result, "shape disable: has success");
    assert("indexName" in result, "shape disable: has indexName");
    assert("refreshInterval" in result, "shape disable: has refreshInterval");
    assert(typeof result.success === "boolean", "shape disable: success is boolean");
    assert(typeof result.indexName === "string", "shape disable: indexName is string");
    assert(typeof result.refreshInterval === "string", "shape disable: refreshInterval is string");
  }

  // --- Test 16: enableAutoRefresh shape ---
  {
    const { deps } = createMockDeps();
    const result = await enableAutoRefresh("ontology-x", "2s", { deps });

    assert("success" in result, "shape enable: has success");
    assert("indexName" in result, "shape enable: has indexName");
    assert("refreshInterval" in result, "shape enable: has refreshInterval");
  }

  // --- Test 17: refreshNow shape ---
  {
    const { deps } = createMockDeps();
    const result = await refreshNow("ontology-x", { deps });

    assert("success" in result, "shape refreshNow: has success");
    assert("indexName" in result, "shape refreshNow: has indexName");
    assert(!("refreshInterval" in result), "shape refreshNow: no refreshInterval");
    assert(!("pattern" in result), "shape refreshNow: no pattern");
  }

  // --- Test 18: refreshAll shape ---
  {
    const { deps } = createMockDeps();
    const result = await refreshAll({ deps });

    assert("success" in result, "shape refreshAll: has success");
    assert("pattern" in result, "shape refreshAll: has pattern");
    assert(!("indexName" in result), "shape refreshAll: no indexName");
    assert(!("refreshInterval" in result), "shape refreshAll: no refreshInterval");
  }

  // =======================================================================
  // Edge case tests
  // =======================================================================

  // --- Test 19: enableAutoRefresh with empty string interval ---
  {
    const { deps } = createMockDeps();
    const result = await enableAutoRefresh("ontology-x", "", { deps });

    // Empty string is a valid call — we pass it through
    assert(result.refreshInterval === "", "empty interval: passes through");
  }

  // --- Test 20: Index names with special characters ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    await disableAutoRefresh("ontology-real-estate-property", { deps });

    assert(
      putSettingsCalls[0].indexName === "ontology-real-estate-property",
      "special chars: index name preserved"
    );
  }

  // --- Test 21: putSettings is NOT called by refreshNow ---
  {
    const { deps, putSettingsCalls } = createMockDeps();
    await refreshNow("ontology-employee", { deps });

    assert(putSettingsCalls.length === 0, "refreshNow: no putSettings calls");
  }

  // --- Test 22: refresh is NOT called by disableAutoRefresh or enableAutoRefresh ---
  {
    const { deps, refreshCalls } = createMockDeps();
    await disableAutoRefresh("ontology-employee", { deps });
    await enableAutoRefresh("ontology-employee", undefined, { deps });

    assert(refreshCalls.length === 0, "settings only: no refresh calls");
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll refreshUtil tests passed");
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
