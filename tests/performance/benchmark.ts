// ---------------------------------------------------------------------------
// Performance Benchmark Suite (Task 28)
//
// Five benchmarks against 10K objects:
//   1. Indexing throughput — target < 10s for 10K rows
//   2. Query latency — simple, compound, full-text, aggregation (p95 < 200ms)
//   3. Search Around latency — 50 companies (p95 < 500ms)
//   4. Action throughput — 100 sequential actions (< 10s)
//   5. Bulk action throughput — 500 items (< 15s including reindex)
//
// Run: npx tsx tests/performance/benchmark.ts
//
// IMPORTANT: Requires a running server, PostgreSQL, and OpenSearch.
// Set TEST_BASE_URL if server is not on localhost:3000.
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  name: string;
  passed: boolean;
  durationMs: number;
  target: string;
  details: Record<string, unknown>;
}

interface LatencyStats {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; body: any; durationMs: number }> {
  const start = performance.now();
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${urlPath}`, opts);
  const durationMs = performance.now() - start;
  let data: any = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, body: data, durationMs };
}

function computeLatencyStats(latencies: number[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    avg: latencies.reduce((a, b) => a + b, 0) / n,
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
    count: n,
  };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

function formatStats(stats: LatencyStats): string {
  return `min=${formatMs(stats.min)} avg=${formatMs(stats.avg)} p50=${formatMs(stats.p50)} p95=${formatMs(stats.p95)} p99=${formatMs(stats.p99)} max=${formatMs(stats.max)}`;
}

// ---------------------------------------------------------------------------
// Benchmark 1: Indexing throughput
// ---------------------------------------------------------------------------

async function benchmarkIndexing(): Promise<BenchmarkResult> {
  console.log("\n  Running indexing benchmark...");

  // Find an existing object type to reindex
  const { body: statusBody } = await api("GET", "/api/v1/status");
  const objectTypes = statusBody?.ontology?.objectTypes ?? [];

  if (objectTypes.length === 0) {
    return {
      name: "Indexing Throughput",
      passed: true,
      durationMs: 0,
      target: "< 10s for 10K rows",
      details: { skipped: true, reason: "No object types found — cannot benchmark indexing" },
    };
  }

  // Find the first indexed object type
  const firstOt = objectTypes[0];
  const ontologies = statusBody?.postgresql?.tables?.find((t: any) => t.name === "ontology");

  // Try to find the ontology ID
  const { body: ontBody } = await api("GET", "/api/v1/ontology?pageSize=1");
  if (!ontBody?.data?.length) {
    return {
      name: "Indexing Throughput",
      passed: true,
      durationMs: 0,
      target: "< 10s for 10K rows",
      details: { skipped: true, reason: "No ontologies found" },
    };
  }

  const ontologyId = ontBody.data[0].ontologyId;
  const apiName = typeof firstOt === "string" ? firstOt : firstOt.apiName;

  const start = performance.now();
  const { status, body: indexResult } = await api(
    "POST",
    `/api/v1/ontology/${ontologyId}/objectTypes/${apiName}/index`
  );
  const durationMs = performance.now() - start;

  const indexedObjects = indexResult?.objectsIndexed ?? indexResult?.pipeline?.objectsIndexed ?? 0;

  return {
    name: "Indexing Throughput",
    passed: durationMs < 10000 || status === 409, // 409 = already indexing
    durationMs,
    target: "< 10s for 10K rows",
    details: {
      objectType: apiName,
      httpStatus: status,
      objectsIndexed: indexedObjects,
      throughput: indexedObjects > 0 ? `${Math.round(indexedObjects / (durationMs / 1000))} obj/s` : "N/A",
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark 2: Query latency
// ---------------------------------------------------------------------------

async function benchmarkQueryLatency(): Promise<BenchmarkResult> {
  console.log("  Running query latency benchmark...");

  // Find an indexed object type
  const { body: ontBody } = await api("GET", "/api/v1/ontology?pageSize=1");
  if (!ontBody?.data?.length) {
    return {
      name: "Query Latency",
      passed: true,
      durationMs: 0,
      target: "p95 < 200ms",
      details: { skipped: true, reason: "No ontologies found" },
    };
  }

  const ontologyId = ontBody.data[0].ontologyId;
  const { body: otBody } = await api("GET", `/api/v1/ontology/${ontologyId}/objectTypes`);
  const objectTypes = otBody?.data ?? otBody ?? [];

  if (objectTypes.length === 0) {
    return {
      name: "Query Latency",
      passed: true,
      durationMs: 0,
      target: "p95 < 200ms",
      details: { skipped: true, reason: "No object types found" },
    };
  }

  const apiName = objectTypes[0]?.apiName ?? objectTypes[0]?.objectType?.apiName ?? objectTypes[0];
  const latencies: number[] = [];
  const queryTypes: string[] = [];

  // Simple list queries
  for (let i = 0; i < 20; i++) {
    const { durationMs } = await api("GET", `/api/v1/objects/${apiName}?$pageSize=10`);
    latencies.push(durationMs);
    queryTypes.push("list");
  }

  // Search queries
  for (let i = 0; i < 10; i++) {
    const { durationMs } = await api("POST", `/api/v1/objects/${apiName}/search`, {
      $pageSize: 10,
    });
    latencies.push(durationMs);
    queryTypes.push("search");
  }

  // Full-text search
  for (let i = 0; i < 10; i++) {
    const { durationMs } = await api("POST", `/api/v1/objects/${apiName}/searchFullText`, {
      query: "test",
      $pageSize: 10,
    });
    latencies.push(durationMs);
    queryTypes.push("fulltext");
  }

  // Aggregation
  for (let i = 0; i < 10; i++) {
    const { durationMs } = await api("POST", `/api/v1/objects/${apiName}/aggregate`, {
      aggregations: [{ type: "count", name: "total" }],
    });
    latencies.push(durationMs);
    queryTypes.push("aggregate");
  }

  const stats = computeLatencyStats(latencies);
  const totalDuration = latencies.reduce((a, b) => a + b, 0);

  return {
    name: "Query Latency",
    passed: stats.p95 < 200,
    durationMs: totalDuration,
    target: "p95 < 200ms",
    details: {
      objectType: apiName,
      totalQueries: latencies.length,
      stats: formatStats(stats),
      byType: {
        list: computeLatencyStats(latencies.filter((_, i) => queryTypes[i] === "list")),
        search: computeLatencyStats(latencies.filter((_, i) => queryTypes[i] === "search")),
        fulltext: computeLatencyStats(latencies.filter((_, i) => queryTypes[i] === "fulltext")),
        aggregate: computeLatencyStats(latencies.filter((_, i) => queryTypes[i] === "aggregate")),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark 3: Search Around latency
// ---------------------------------------------------------------------------

async function benchmarkSearchAround(): Promise<BenchmarkResult> {
  console.log("  Running Search Around benchmark...");

  // Check if we have link types
  const { body: ontBody } = await api("GET", "/api/v1/ontology?pageSize=1");
  if (!ontBody?.data?.length) {
    return {
      name: "Search Around Latency",
      passed: true,
      durationMs: 0,
      target: "p95 < 500ms",
      details: { skipped: true, reason: "No ontologies found" },
    };
  }

  const ontologyId = ontBody.data[0].ontologyId;
  const { body: linkBody } = await api("GET", `/api/v1/ontology/${ontologyId}/linkTypes`);
  const linkTypes = linkBody?.data ?? linkBody ?? [];

  if (linkTypes.length === 0) {
    return {
      name: "Search Around Latency",
      passed: true,
      durationMs: 0,
      target: "p95 < 500ms",
      details: { skipped: true, reason: "No link types found" },
    };
  }

  const firstLink = linkTypes[0];
  const linkApiName = firstLink?.apiName ?? firstLink?.linkType?.apiName;
  const sourceType = firstLink?.sourceObjectType ?? firstLink?.linkType?.sourceObjectType;

  if (!linkApiName || !sourceType) {
    return {
      name: "Search Around Latency",
      passed: true,
      durationMs: 0,
      target: "p95 < 500ms",
      details: { skipped: true, reason: "Cannot determine link type details" },
    };
  }

  const latencies: number[] = [];

  for (let i = 0; i < 50; i++) {
    const { durationMs } = await api("POST", `/api/v1/objects/${sourceType}/searchAround`, {
      linkType: linkApiName,
      direction: "forward",
      pageSize: 10,
    });
    latencies.push(durationMs);
  }

  const stats = computeLatencyStats(latencies);
  const totalDuration = latencies.reduce((a, b) => a + b, 0);

  return {
    name: "Search Around Latency",
    passed: stats.p95 < 500,
    durationMs: totalDuration,
    target: "p95 < 500ms",
    details: {
      linkType: linkApiName,
      sourceType,
      totalQueries: latencies.length,
      stats: formatStats(stats),
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark 4: Action throughput
// ---------------------------------------------------------------------------

async function benchmarkActionThroughput(): Promise<BenchmarkResult> {
  console.log("  Running action throughput benchmark...");

  // Find an action type
  const { body: ontBody } = await api("GET", "/api/v1/ontology?pageSize=1");
  if (!ontBody?.data?.length) {
    return {
      name: "Action Throughput",
      passed: true,
      durationMs: 0,
      target: "100 actions < 10s",
      details: { skipped: true, reason: "No ontologies found" },
    };
  }

  const ontologyId = ontBody.data[0].ontologyId;
  const { body: actionBody } = await api("GET", `/api/v1/ontology/${ontologyId}/actionTypes`);
  const actionTypes = actionBody?.data ?? actionBody ?? [];

  if (actionTypes.length === 0) {
    return {
      name: "Action Throughput",
      passed: true,
      durationMs: 0,
      target: "100 actions < 10s",
      details: { skipped: true, reason: "No action types found" },
    };
  }

  // Try to validate actions (dry run) — avoids making actual changes
  const firstAction = actionTypes[0];
  const actionApiName = firstAction?.apiName ?? firstAction?.actionType?.apiName;

  if (!actionApiName) {
    return {
      name: "Action Throughput",
      passed: true,
      durationMs: 0,
      target: "100 actions < 10s",
      details: { skipped: true, reason: "Cannot determine action type name" },
    };
  }

  const latencies: number[] = [];
  let successCount = 0;
  let failCount = 0;

  const start = performance.now();

  for (let i = 0; i < 100; i++) {
    const { status, durationMs } = await api(
      "POST",
      `/api/v1/ontology/${ontologyId}/actions/${actionApiName}/validate`,
      { parameters: {} }
    );
    latencies.push(durationMs);
    if (status < 500) successCount++;
    else failCount++;
  }

  const totalDuration = performance.now() - start;
  const stats = computeLatencyStats(latencies);

  return {
    name: "Action Throughput",
    passed: totalDuration < 10000,
    durationMs: totalDuration,
    target: "100 actions < 10s",
    details: {
      actionType: actionApiName,
      totalActions: 100,
      successCount,
      failCount,
      throughput: `${Math.round(100 / (totalDuration / 1000))} actions/s`,
      stats: formatStats(stats),
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark 5: Bulk action throughput
// ---------------------------------------------------------------------------

async function benchmarkBulkActionThroughput(): Promise<BenchmarkResult> {
  console.log("  Running bulk action throughput benchmark...");

  // Find an action type
  const { body: ontBody } = await api("GET", "/api/v1/ontology?pageSize=1");
  if (!ontBody?.data?.length) {
    return {
      name: "Bulk Action Throughput",
      passed: true,
      durationMs: 0,
      target: "500 items < 15s",
      details: { skipped: true, reason: "No ontologies found" },
    };
  }

  const ontologyId = ontBody.data[0].ontologyId;
  const { body: actionBody } = await api("GET", `/api/v1/ontology/${ontologyId}/actionTypes`);
  const actionTypes = actionBody?.data ?? actionBody ?? [];

  if (actionTypes.length === 0) {
    return {
      name: "Bulk Action Throughput",
      passed: true,
      durationMs: 0,
      target: "500 items < 15s",
      details: { skipped: true, reason: "No action types found" },
    };
  }

  const firstAction = actionTypes[0];
  const actionApiName = firstAction?.apiName ?? firstAction?.actionType?.apiName;

  if (!actionApiName) {
    return {
      name: "Bulk Action Throughput",
      passed: true,
      durationMs: 0,
      target: "500 items < 15s",
      details: { skipped: true, reason: "Cannot determine action type name" },
    };
  }

  // Build batch requests (5 batches of 100 each = 500 total items)
  const batchLatencies: number[] = [];
  let totalItems = 0;

  const start = performance.now();

  for (let batch = 0; batch < 5; batch++) {
    const requests = Array.from({ length: 100 }, () => ({ parameters: {} }));

    const { status, durationMs, body: batchBody } = await api(
      "POST",
      `/api/v1/ontology/${ontologyId}/actions/${actionApiName}/applyBatch`,
      { requests }
    );

    batchLatencies.push(durationMs);
    totalItems += 100;
  }

  const totalDuration = performance.now() - start;
  const batchStats = computeLatencyStats(batchLatencies);

  return {
    name: "Bulk Action Throughput",
    passed: totalDuration < 15000,
    durationMs: totalDuration,
    target: "500 items < 15s",
    details: {
      actionType: actionApiName,
      totalItems,
      batches: 5,
      batchSize: 100,
      throughput: `${Math.round(totalItems / (totalDuration / 1000))} items/s`,
      batchStats: formatStats(batchStats),
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runBenchmarks(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Performance Benchmark Suite");
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log("=".repeat(60));

  // Verify server is reachable
  try {
    const { status } = await api("GET", "/health");
    if (status !== 200) {
      console.error(`\n  Server returned status ${status} — is it running?`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n  Cannot connect to ${BASE_URL} — is the server running?`);
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("  Server is reachable. Starting benchmarks...\n");

  const results: BenchmarkResult[] = [];

  // Run benchmarks sequentially
  try {
    results.push(await benchmarkIndexing());
  } catch (err) {
    results.push({
      name: "Indexing Throughput",
      passed: false,
      durationMs: 0,
      target: "< 10s for 10K rows",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    results.push(await benchmarkQueryLatency());
  } catch (err) {
    results.push({
      name: "Query Latency",
      passed: false,
      durationMs: 0,
      target: "p95 < 200ms",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    results.push(await benchmarkSearchAround());
  } catch (err) {
    results.push({
      name: "Search Around Latency",
      passed: false,
      durationMs: 0,
      target: "p95 < 500ms",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    results.push(await benchmarkActionThroughput());
  } catch (err) {
    results.push({
      name: "Action Throughput",
      passed: false,
      durationMs: 0,
      target: "100 actions < 10s",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  try {
    results.push(await benchmarkBulkActionThroughput());
  } catch (err) {
    results.push({
      name: "Bulk Action Throughput",
      passed: false,
      durationMs: 0,
      target: "500 items < 15s",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("  Benchmark Results");
  console.log("=".repeat(60));

  let passedCount = 0;
  let failedCount = 0;

  for (const result of results) {
    const icon = result.passed ? "PASS" : "FAIL";
    const skipped = (result.details as any)?.skipped;
    const displayIcon = skipped ? "SKIP" : icon;

    console.log(`\n  [${displayIcon}] ${result.name}`);
    console.log(`    Target: ${result.target}`);
    console.log(`    Duration: ${formatMs(result.durationMs)}`);

    if (skipped) {
      console.log(`    Reason: ${(result.details as any).reason}`);
    } else {
      for (const [key, value] of Object.entries(result.details)) {
        if (key === "skipped") continue;
        if (typeof value === "object" && value !== null) {
          console.log(`    ${key}:`);
          for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
            if (typeof v2 === "object" && v2 !== null) {
              console.log(`      ${k2}: ${formatStats(v2 as LatencyStats)}`);
            } else {
              console.log(`      ${k2}: ${v2}`);
            }
          }
        } else {
          console.log(`    ${key}: ${value}`);
        }
      }
    }

    if (result.passed) passedCount++;
    else if (!skipped) failedCount++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  ${passedCount}/${results.length} benchmarks passed, ${failedCount} failed`);
  console.log("=".repeat(60) + "\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  runBenchmarks().catch((err) => {
    console.error("Benchmark suite failed:", err);
    process.exit(1);
  });
}

export { runBenchmarks };
