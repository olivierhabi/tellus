// ---------------------------------------------------------------------------
// Sunday Performance Benchmarks
//
// Tests performance of Sunday features:
//   1. Interface CRUD throughput
//   2. Polymorphic query latency
//   3. Object View latency
//   4. Batch object view throughput
//
// Usage:
//   npx tsx tests/performance/sundayBenchmark.ts
//   npm run test:sunday:perf
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  target: string;
  passed: boolean;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(timings: number[], name: string, target: string, targetP95: number): BenchmarkResult {
  const sorted = [...timings].sort((a, b) => a - b);
  const total = sorted.reduce((s, t) => s + t, 0);
  return {
    name,
    iterations: sorted.length,
    totalMs: Math.round(total),
    avgMs: Math.round(total / sorted.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    target,
    passed: percentile(sorted, 95) <= targetP95,
  };
}

async function api(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

async function timeMs(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return Math.round(performance.now() - start);
}

// ---------------------------------------------------------------------------
// Benchmark 1: Interface CRUD Throughput
// ---------------------------------------------------------------------------
async function benchmarkInterfaceCrud(ontologyId: string): Promise<BenchmarkResult> {
  const timings: number[] = [];
  const count = 50;

  for (let i = 0; i < count; i++) {
    const ms = await timeMs(async () => {
      const name = `BenchIf${String(i).padStart(4, "0")}`;
      await api("POST", `/api/v2/ontology/${ontologyId}/interfaces`, {
        apiName: name,
        displayName: `Benchmark Interface ${i}`,
        properties: [
          { apiName: "prop1", displayName: "Prop 1", baseType: "string" },
          { apiName: "prop2", displayName: "Prop 2", baseType: "double" },
        ],
      });
    });
    timings.push(ms);
  }

  // Cleanup
  for (let i = 0; i < count; i++) {
    const name = `BenchIf${String(i).padStart(4, "0")}`;
    await api("DELETE", `/api/v2/ontology/${ontologyId}/interfaces/${name}`);
  }

  return computeStats(timings, "Interface CRUD (create)", "p95 < 200ms", 200);
}

// ---------------------------------------------------------------------------
// Benchmark 2: Polymorphic Query Latency
// ---------------------------------------------------------------------------
async function benchmarkPolymorphicQuery(ontologyId: string): Promise<BenchmarkResult | null> {
  // Check if any interfaces exist
  const { body: ifList } = await api("GET", `/api/v2/ontology/${ontologyId}/interfaces`);
  if (!ifList?.data || ifList.data.length === 0) {
    console.log("  [SKIP] No interfaces found for polymorphic query benchmark");
    return null;
  }

  const ifName = ifList.data[0].apiName;
  const timings: number[] = [];

  for (let i = 0; i < 50; i++) {
    const ms = await timeMs(async () => {
      await api("POST", `/api/v2/ontology/${ontologyId}/interfaces/${ifName}/search`, {
        $pageSize: 20,
      });
    });
    timings.push(ms);
  }

  return computeStats(timings, "Polymorphic Search", "p95 < 500ms", 500);
}

// ---------------------------------------------------------------------------
// Benchmark 3: Object View Latency
// ---------------------------------------------------------------------------
async function benchmarkObjectView(ontologyId: string): Promise<BenchmarkResult | null> {
  // Find an object type with indexed data
  const { body: otList } = await api("GET", `/api/v2/ontologies/${ontologyId}/objectTypes`);
  if (!otList?.data || otList.data.length === 0) {
    console.log("  [SKIP] No object types found for view benchmark");
    return null;
  }

  const otApiName = otList.data[0].apiName;
  // Try to get an object
  const { status, body: searchResult } = await api("POST", `/api/v2/objects/${otApiName}/search`, {
    $pageSize: 1,
  });

  if (status !== 200 || !searchResult?.data || searchResult.data.length === 0) {
    console.log("  [SKIP] No indexed objects found for view benchmark");
    return null;
  }

  const pk = searchResult.data[0].__primaryKey || searchResult.data[0][Object.keys(searchResult.data[0])[0]];
  const timings: number[] = [];

  for (let i = 0; i < 50; i++) {
    const ms = await timeMs(async () => {
      await api("GET", `/api/v2/ontology/${ontologyId}/objectTypes/${otApiName}/objects/${pk}/view`);
    });
    timings.push(ms);
  }

  return computeStats(timings, "Object View (single)", "p95 < 200ms", 200);
}

// ---------------------------------------------------------------------------
// Benchmark 4: Batch Object View Throughput
// ---------------------------------------------------------------------------
async function benchmarkBatchView(ontologyId: string): Promise<BenchmarkResult | null> {
  const { body: otList } = await api("GET", `/api/v2/ontologies/${ontologyId}/objectTypes`);
  if (!otList?.data || otList.data.length === 0) return null;

  const otApiName = otList.data[0].apiName;
  const { status, body: searchResult } = await api("POST", `/api/v2/objects/${otApiName}/search`, {
    $pageSize: 50,
  });

  if (status !== 200 || !searchResult?.data || searchResult.data.length < 5) {
    console.log("  [SKIP] Not enough indexed objects for batch view benchmark");
    return null;
  }

  const pks = searchResult.data.slice(0, 50).map((o: any) => o.__primaryKey || o[Object.keys(o)[0]]);
  const timings: number[] = [];

  for (let i = 0; i < 20; i++) {
    const ms = await timeMs(async () => {
      await api("POST", `/api/v2/ontology/${ontologyId}/objectTypes/${otApiName}/objects/batchView`, {
        primaryKeys: pks,
        include: ["properties"],
      });
    });
    timings.push(ms);
  }

  return computeStats(timings, "Batch Object View (50 PKs)", "p95 < 3000ms", 3000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\n========================================");
  console.log("  Sunday Performance Benchmarks");
  console.log("========================================");
  console.log(`Target: ${BASE_URL}\n`);

  // Check server
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error("Server not healthy");
  } catch {
    console.log("Server not reachable. Skipping benchmarks.");
    process.exit(0);
  }

  // Get or create an ontology
  let ontologyId: string;
  const { body: ontList } = await api("GET", "/api/v2/ontologies?pageSize=1");
  if (ontList?.data?.length > 0) {
    ontologyId = ontList.data[0].ontologyId;
  } else {
    const { body: created } = await api("POST", "/api/v2/ontologies", {
      displayName: "Sunday Benchmark Ontology",
    });
    ontologyId = created.data?.ontologyId || created.ontologyId;
  }

  console.log(`Using ontology: ${ontologyId}\n`);

  const results: BenchmarkResult[] = [];

  // Run benchmarks
  console.log("--- Benchmark 1: Interface CRUD ---");
  results.push(await benchmarkInterfaceCrud(ontologyId));

  console.log("--- Benchmark 2: Polymorphic Query ---");
  const polyResult = await benchmarkPolymorphicQuery(ontologyId);
  if (polyResult) results.push(polyResult);

  console.log("--- Benchmark 3: Object View ---");
  const viewResult = await benchmarkObjectView(ontologyId);
  if (viewResult) results.push(viewResult);

  console.log("--- Benchmark 4: Batch Object View ---");
  const batchResult = await benchmarkBatchView(ontologyId);
  if (batchResult) results.push(batchResult);

  // Report
  console.log("\n========================================");
  console.log("  Results");
  console.log("========================================\n");

  const nameWidth = 35;
  console.log(
    "Benchmark".padEnd(nameWidth) +
    "Iter".padStart(6) +
    "Avg".padStart(8) +
    "P50".padStart(8) +
    "P95".padStart(8) +
    "P99".padStart(8) +
    "Max".padStart(8) +
    "  Result"
  );
  console.log("-".repeat(nameWidth + 54));

  for (const r of results) {
    console.log(
      r.name.padEnd(nameWidth) +
      String(r.iterations).padStart(6) +
      `${r.avgMs}ms`.padStart(8) +
      `${r.p50Ms}ms`.padStart(8) +
      `${r.p95Ms}ms`.padStart(8) +
      `${r.p99Ms}ms`.padStart(8) +
      `${r.maxMs}ms`.padStart(8) +
      `  ${r.passed ? "PASS" : "WARN"}`
    );
  }

  const allPassed = results.every((r) => r.passed);
  console.log(`\nOverall: ${allPassed ? "ALL TARGETS MET" : "SOME TARGETS MISSED"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Benchmark failed:", err.message);
  process.exit(1);
});
