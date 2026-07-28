const token = process.env.TELLUS_ACCEPTANCE_TOKEN;
const transactionId = process.env.TELLUS_TRANSACTION_ID;
const scenarioRid = process.env.TELLUS_SCENARIO_RID;
const durationMs = Number(process.env.DURATION_MS ?? 60_000);
const concurrency = Number(process.env.CONCURRENCY ?? 20);
if (!token || !transactionId || !scenarioRid) throw new Error("missing context");

const latency = [];
let requests = 0;
let errors = 0;
const deadline = Date.now() + durationMs;
const objectSet = { type: "base", objectType: "Employee" };
const workloads = [
  {
    path: "objectSets/loadObjects",
    query: "",
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    path: "objectSets/loadObjects",
    query: `?transactionId=${encodeURIComponent(transactionId)}`,
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    path: "objectSets/loadObjects",
    query: `?scenarioRid=${encodeURIComponent(scenarioRid)}`,
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    path: "objectSets/aggregate",
    query: "",
    body: {
      objectSet,
      aggregation: [{ type: "count" }],
      groupBy: [{ type: "exact", field: "department" }],
      accuracy: "ALLOW_APPROXIMATE",
    },
  },
];

async function worker(workerId) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const workload = workloads[(workerId + iteration) % workloads.length];
    const port = (workerId + iteration) % 2 === 0 ? 3300 : 3301;
    const start = performance.now();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v2/ontologies/00000000-0000-0000-0000-000000000001/${workload.path}${workload.query}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(workload.body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      await response.arrayBuffer();
      if (!response.ok) errors += 1;
    } catch {
      errors += 1;
    }
    latency.push(performance.now() - start);
    requests += 1;
    iteration += 1;
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
latency.sort((a, b) => a - b);
const percentile = (p) =>
  latency[Math.min(latency.length - 1, Math.floor(latency.length * p))] ?? 0;
console.log(JSON.stringify({
  classification: "SMOKE_ONLY_NOT_A_REQUIRED_15_OR_60_MINUTE_GATE",
  durationMs,
  concurrency,
  requests,
  throughputPerSecond: requests / (durationMs / 1000),
  errors,
  errorRate: errors / requests,
  latencyMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: latency.at(-1) ?? 0,
  },
}, null, 2));
