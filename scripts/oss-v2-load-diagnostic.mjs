import { writeFile } from "node:fs/promises";

const token = process.env.TELLUS_ACCEPTANCE_TOKEN;
const transactionId = process.env.TELLUS_TRANSACTION_ID;
const scenarioRid = process.env.TELLUS_SCENARIO_RID;
const outputPath = process.env.OUTPUT_PATH;
const durationMs = Number(process.env.DURATION_MS ?? 60_000);
const concurrency = Number(process.env.CONCURRENCY ?? 20);
const targetRps = Number(process.env.TARGET_RPS ?? 0);
const tenant = process.env.TELLUS_TENANT ?? "default";
const ontology =
  process.env.TELLUS_ONTOLOGY ??
  "00000000-0000-0000-0000-000000000001";
const ports = (process.env.TELLUS_API_PORTS ?? "3300,3301")
  .split(",")
  .map(Number);

if (!token || !transactionId || !scenarioRid) {
  throw new Error("missing authentication or read-context configuration");
}
if (
  !Number.isFinite(durationMs) ||
  durationMs < 1 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  ports.some((port) => !Number.isInteger(port) || port < 1)
) {
  throw new Error("invalid load configuration");
}

const objectSet = { type: "base", objectType: "Employee" };
const workloads = [
  {
    name: "base_read",
    route: "objectSets/loadObjects",
    query: "",
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    name: "transaction_read",
    route: "objectSets/loadObjects",
    query: `?transactionId=${encodeURIComponent(transactionId)}`,
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    name: "scenario_read",
    route: "objectSets/loadObjects",
    query: `?scenarioRid=${encodeURIComponent(scenarioRid)}`,
    body: { objectSet, select: ["employeeId", "name"], pageSize: 10 },
  },
  {
    name: "approximate_aggregation",
    route: "objectSets/aggregate",
    query: "",
    body: {
      objectSet,
      aggregation: [{ type: "count" }],
      groupBy: [{ type: "exact", field: "department" }],
      accuracy: "ALLOW_APPROXIMATE",
    },
  },
];

const startedAt = Date.now();
const deadline = startedAt + durationMs;
const latency = [];
const counters = {
  status: {},
  errorName: {},
  route: {},
  node: {},
  tenant: {},
  workload: {},
  dependency: {},
  latencyBucket: {},
  retryAttempt: {},
  connectionError: {},
  timestampMinute: {},
};
const samples = [];
let requests = 0;
let successful = 0;
let expectedRateLimited = 0;
let unexpectedFailures = 0;
let active = 0;
let maxActive = 0;
let issued = 0;
let nextScheduledAt = startedAt;

function increment(dimension, value, failed) {
  const key = String(value ?? "none");
  const entry = (counters[dimension][key] ??= {
    total: 0,
    failed: 0,
  });
  entry.total += 1;
  if (failed) entry.failed += 1;
}

function latencyBucket(ms) {
  if (ms < 10) return "lt_10ms";
  if (ms < 50) return "10_49ms";
  if (ms < 100) return "50_99ms";
  if (ms < 500) return "100_499ms";
  if (ms < 1_000) return "500_999ms";
  if (ms < 5_000) return "1_4s";
  return "gte_5s";
}

function dependencyFor(status, errorName) {
  if (status === 429 || errorName === "RateLimitExceeded") return "rate_limiter";
  if (errorName?.includes("OpenSearch")) return "opensearch";
  if (errorName?.includes("Redis")) return "redis";
  if (errorName?.includes("Database") || errorName?.includes("Transaction")) {
    return "postgres";
  }
  if (status >= 500) return "application_or_dependency";
  return "none";
}

function connectionErrorName(error) {
  const cause = error?.cause;
  return (
    cause?.code ??
    error?.code ??
    (error?.name === "TimeoutError" ? "CLIENT_TIMEOUT" : error?.name) ??
    "UNKNOWN"
  );
}

async function pace() {
  if (!(targetRps > 0)) return;
  // Reservation is synchronous, so concurrent workers receive distinct,
  // globally spaced slots instead of waking in a burst.
  const scheduledAt = nextScheduledAt;
  nextScheduledAt += 1_000 / targetRps;
  issued += 1;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 1_000)));
  }
}

async function worker(workerId) {
  let iteration = 0;
  while (Date.now() < deadline) {
    await pace();
    if (Date.now() >= deadline) break;
    const workload = workloads[(workerId + iteration) % workloads.length];
    const port = ports[(workerId + iteration) % ports.length];
    const start = performance.now();
    let status = 0;
    let errorName = null;
    let responseBody = null;
    let connectionError = "none";
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v2/ontologies/${ontology}/${workload.route}${workload.query}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-tellus-tenant": tenant,
          },
          body: JSON.stringify(workload.body),
          signal: AbortSignal.timeout(10_000),
        },
      );
      status = response.status;
      const text = await response.text();
      try {
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        responseBody = { nonJsonBytes: Buffer.byteLength(text) };
      }
      errorName =
        responseBody?.errorName ??
        responseBody?.error?.errorName ??
        responseBody?.error?.code ??
        null;
      if (response.ok) {
        successful += 1;
      } else if (status === 429) {
        expectedRateLimited += 1;
      } else {
        unexpectedFailures += 1;
      }
    } catch (error) {
      unexpectedFailures += 1;
      connectionError = connectionErrorName(error);
      errorName = error?.name ?? "ClientRequestError";
      responseBody = { message: String(error?.message ?? error) };
    } finally {
      active -= 1;
    }

    const elapsed = performance.now() - start;
    const failed = status < 200 || status >= 300;
    latency.push(elapsed);
    requests += 1;
    increment("status", status || "connection_error", failed);
    increment("errorName", errorName ?? "none", failed);
    increment("route", workload.route, failed);
    increment("node", port, failed);
    increment("tenant", tenant, failed);
    increment("workload", workload.name, failed);
    increment("dependency", dependencyFor(status, errorName), failed);
    increment("latencyBucket", latencyBucket(elapsed), failed);
    increment("retryAttempt", 1, failed);
    increment("connectionError", connectionError, failed);
    increment(
      "timestampMinute",
      new Date().toISOString().slice(0, 16),
      failed,
    );

    if (failed && samples.length < 20) {
      samples.push({
        at: new Date().toISOString(),
        node: port,
        tenant,
        workload: workload.name,
        route: workload.route,
        status: status || null,
        errorName,
        dependency: dependencyFor(status, errorName),
        connectionError,
        retryAttempt: 1,
        latencyMs: Number(elapsed.toFixed(3)),
        response: responseBody,
      });
    }
    iteration += 1;
  }
}

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => worker(index)),
);

latency.sort((a, b) => a - b);
const percentile = (p) =>
  latency[Math.min(latency.length - 1, Math.floor(latency.length * p))] ?? 0;
const elapsedMs = Date.now() - startedAt;
const report = {
  configuration: {
    durationMs,
    concurrency,
    targetRps: targetRps || "unbounded",
    issued,
    ports,
    tenant,
    ontology,
    workloadCount: workloads.length,
    clientRetries: false,
  },
  audit: {
    waitsForResponse: true,
    boundedConcurrency: true,
    maxObservedConcurrency: maxActive,
    accidentalInfiniteLoop: false,
    retryWithoutBackoff: false,
    intentionalRateLimitsSeparated: true,
    authenticationConfigured: true,
    identifiersConfigured: true,
    snapshotTokensReused: false,
    responseBodiesConsumed: true,
    resourcesClosedByFetch: true,
    pacing: targetRps > 0 ? "global target RPS" : "none",
  },
  result: {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    elapsedMs,
    requests,
    achievedRequestsPerSecond: requests / (elapsedMs / 1_000),
    successful,
    expectedRateLimited,
    unexpectedFailures,
    unexpectedErrorRate: requests === 0 ? 0 : unexpectedFailures / requests,
    totalNonSuccessRate:
      requests === 0
        ? 0
        : (expectedRateLimited + unexpectedFailures) / requests,
    latencyMs: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latency.at(-1) ?? 0,
    },
  },
  breakdown: counters,
  representativeFailures: samples,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, { mode: 0o600 });
process.stdout.write(serialized);
