import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

const token = process.env.TELLUS_ACCEPTANCE_TOKEN;
const transactionId = process.env.TELLUS_TRANSACTION_ID;
const scenarioRid = process.env.TELLUS_SCENARIO_RID;
const durationMs = Number(process.env.DURATION_MS ?? 300_000);
const concurrency = Number(process.env.CONCURRENCY ?? 20);
const targetOperationsPerSecond = Number(process.env.TARGET_RPS ?? 3);
const outputPath = process.env.OUTPUT_PATH;
const tenant = process.env.TELLUS_TENANT ?? "default";
const ontology =
  process.env.TELLUS_ONTOLOGY ??
  "00000000-0000-0000-0000-000000000001";
const ports = (process.env.TELLUS_API_PORTS ?? "3300,3301")
  .split(",")
  .map(Number);
// Tellus staging targets, declared by the harness before a run. They are
// configurable only through the recorded process environment so a report
// always contains the exact thresholds used for its verdict.
const ordinaryReadP95TargetMs = Number(
  process.env.SLO_ORDINARY_READ_P95_MS ?? 2_000,
);
const mixedOperationP99TargetMs = Number(
  process.env.SLO_MIXED_OPERATION_P99_MS ?? 10_000,
);
const subscriptionUpdateP99TargetMs = Number(
  process.env.SLO_SUBSCRIPTION_UPDATE_P99_MS ?? 5_000,
);

if (!token || !transactionId || !scenarioRid) {
  throw new Error("missing authentication or read-context configuration");
}
if (!(durationMs > 0) || !(targetOperationsPerSecond > 0)) {
  throw new Error("duration and target RPS must be positive");
}

const employee = { type: "base", objectType: "Employee" };
const requestLatency = [];
const operationLatency = [];
const statusCounts = {};
const errorNameCounts = {};
const workloadCounts = {};
const nodeCounts = {};
const workloadLatency = {};
const samples = [];
let httpRequests = 0;
let operations = 0;
let unexpectedFailures = 0;
let expectedRateLimits = 0;
let active = 0;
let maxActive = 0;
let nextScheduledAt = Date.now();
let sequence = 0;

function increment(record, key) {
  record[String(key)] = (record[String(key)] ?? 0) + 1;
}

function queryString(context = {}) {
  const query = new URLSearchParams();
  if (context.transactionId) query.set("transactionId", context.transactionId);
  if (context.scenarioRid) query.set("scenarioRid", context.scenarioRid);
  return query.size > 0 ? `?${query}` : "";
}

async function apiRequest({
  port,
  route,
  body,
  context,
  workload,
  expectedStatuses = [200],
}) {
  const started = performance.now();
  active += 1;
  maxActive = Math.max(maxActive, active);
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v2/ontologies/${ontology}/${route}${queryString(context)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-tellus-tenant": tenant,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { nonJsonBytes: Buffer.byteLength(text) };
    }
    const errorName =
      parsed?.errorName ?? parsed?.error?.errorName ?? parsed?.error?.code;
    increment(statusCounts, response.status);
    increment(errorNameCounts, errorName ?? "none");
    increment(nodeCounts, port);
    httpRequests += 1;
    if (!expectedStatuses.includes(response.status)) {
      if (response.status === 429) expectedRateLimits += 1;
      else unexpectedFailures += 1;
      if (samples.length < 30) {
        samples.push({
          at: new Date().toISOString(),
          workload,
          port,
          status: response.status,
          errorName: errorName ?? null,
          response: parsed,
        });
      }
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    httpRequests += 1;
    unexpectedFailures += 1;
    increment(statusCounts, "connection_error");
    increment(errorNameCounts, error?.cause?.code ?? error?.name ?? "unknown");
    increment(nodeCounts, port);
    if (samples.length < 30) {
      samples.push({
        at: new Date().toISOString(),
        workload,
        port,
        status: null,
        errorName: error?.cause?.code ?? error?.name ?? "unknown",
        response: { message: String(error?.message ?? error) },
      });
    }
    return { status: 0, body: null };
  } finally {
    active -= 1;
    requestLatency.push(performance.now() - started);
  }
}

const loadBody = (objectSet = employee, extra = {}) => ({
  objectSet,
  select: ["employeeId", "name", "department"],
  pageSize: 10,
  ...extra,
});

const workloads = [
  {
    name: "ordinary_read",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(),
        workload: "ordinary_read",
      }),
  },
  {
    name: "filter",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody({
          type: "filter",
          objectSet: employee,
          where: {
            type: "and",
            value: [
              { type: "eq", field: "department", value: "Engineering" },
              { type: "gte", field: "salary", value: 100 },
            ],
          },
        }),
        workload: "filter",
      }),
  },
  {
    name: "cross_type_read",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjectsMultipleObjectTypes",
        body: {
          objectSet: {
            type: "union",
            objectSets: [
              employee,
              { type: "base", objectType: "Company" },
            ],
          },
          select: [],
          selectV2: [],
          pageSize: 10,
        },
        workload: "cross_type_read",
      }),
  },
  {
    name: "transaction_read",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(),
        context: { transactionId },
        workload: "transaction_read",
      }),
  },
  {
    name: "scenario_read",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(),
        context: { scenarioRid },
        workload: "scenario_read",
      }),
  },
  {
    name: "combined_context_read",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(),
        context: { transactionId, scenarioRid },
        workload: "combined_context_read",
      }),
  },
  {
    name: "snapshot_pagination",
    run: async (port) => {
      const first = await apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(employee, { pageSize: 2, snapshot: true }),
        workload: "snapshot_pagination:first",
      });
      const pageToken = first.body?.nextPageToken;
      if (first.status === 200 && !pageToken) {
        unexpectedFailures += 1;
        samples.push({
          workload: "snapshot_pagination:first",
          port,
          status: 200,
          errorName: "MissingPageToken",
        });
        return;
      }
      if (pageToken) {
        await apiRequest({
          port: ports[(ports.indexOf(port) + 1) % ports.length],
          route: "objectSets/loadObjects",
          body: loadBody(employee, {
            pageSize: 2,
            snapshot: true,
            pageToken,
          }),
          workload: "snapshot_pagination:next",
        });
      }
    },
  },
  {
    name: "exact_aggregation",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/aggregate",
        body: {
          objectSet: employee,
          aggregation: [
            { type: "count" },
            { type: "sum", field: "salary" },
            { type: "avg", field: "salary" },
          ],
          groupBy: [
            {
              type: "exact",
              field: "department",
              includeNullValues: true,
            },
          ],
          accuracy: "REQUIRE_ACCURATE",
        },
        workload: "exact_aggregation",
      }),
  },
  {
    name: "approximate_aggregation",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/aggregate",
        body: {
          objectSet: employee,
          aggregation: [{ type: "count" }],
          groupBy: [{ type: "exact", field: "department" }],
          accuracy: "ALLOW_APPROXIMATE",
        },
        workload: "approximate_aggregation",
      }),
  },
  {
    name: "vector_knn",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(
          {
            type: "nearestNeighbors",
            objectSet: employee,
            propertyIdentifier: { type: "property", apiName: "embedding" },
            numNeighbors: 3,
            query: { type: "vector", value: [0.1, 0.2, 0.3] },
          },
          { pageSize: 3 },
        ),
        workload: "vector_knn",
      }),
  },
  {
    name: "text_knn",
    run: (port) =>
      apiRequest({
        port,
        route: "objectSets/loadObjects",
        body: loadBody(
          {
            type: "nearestNeighbors",
            objectSet: employee,
            propertyIdentifier: { type: "property", apiName: "embedding" },
            numNeighbors: 3,
            query: { type: "text", value: "Alice engineering" },
          },
          { pageSize: 3 },
        ),
        workload: "text_knn",
      }),
  },
  {
    name: "action_validation",
    run: (port) =>
      apiRequest({
        port,
        route: "actions/createEmployee/apply",
        body: {
          parameters: {
            employeeId: "E-LOAD-VALIDATION",
            name: "Load Validation",
            department: "QA",
          },
          options: { mode: "VALIDATE_ONLY", returnEdits: "ALL" },
        },
        workload: "action_validation",
      }),
  },
  {
    name: "action_execution",
    run: (port) => {
      const id = `E-LOAD-${Date.now()}-${sequence++}`;
      return apiRequest({
        port,
        route: "actions/createEmployee/apply",
        body: {
          parameters: {
            employeeId: id,
            name: "Load Event",
            department: "Streaming",
          },
          options: { mode: "VALIDATE_AND_EXECUTE", returnEdits: "ALL" },
        },
        workload: "action_execution",
      });
    },
  },
];

const subscription = {
  acknowledged: false,
  id: null,
  cursor: null,
  updates: 0,
  errors: [],
  openedAt: null,
  closedAt: null,
};

async function openSubscription() {
  const url =
    `ws://127.0.0.1:${ports[0]}/api/v2/ontologies/${ontology}` +
    "/objectSets/stream";
  const ws = new WebSocket(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tellus-tenant": tenant,
    },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("subscription acknowledgment timed out")),
      10_000,
    );
    ws.once("open", () => {
      subscription.openedAt = new Date().toISOString();
      ws.send(
        JSON.stringify({
          type: "subscribeRequests",
          id: `mixed-load-${Date.now()}`,
          requests: [
            {
              objectSet: employee,
              propertySet: ["employeeId", "name", "department"],
              referenceSet: [],
            },
          ],
        }),
      );
    });
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "subscribeResponses") {
        const response = frame.responses?.[0];
        if (response?.type === "success") {
          subscription.acknowledged = true;
          subscription.id = response.id;
          subscription.cursor = response.cursor;
          clearTimeout(timeout);
          resolve();
        }
      } else if (frame.type === "objectSetChanged") {
        subscription.updates += 1;
        subscription.cursor = frame.cursor;
      } else if (frame.type === "error") {
        subscription.errors.push(frame);
      }
    });
    ws.once("error", reject);
  });
  return ws;
}

const startedAt = Date.now();
const deadline = startedAt + durationMs;
const ws = await openSubscription();

async function pace() {
  const scheduledAt = nextScheduledAt;
  nextScheduledAt += 1_000 / targetOperationsPerSecond;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function worker(workerId) {
  let iteration = 0;
  while (Date.now() < deadline) {
    await pace();
    if (Date.now() >= deadline) break;
    const workload = workloads[(workerId + iteration) % workloads.length];
    const port = ports[(workerId + iteration) % ports.length];
    const started = performance.now();
    await workload.run(port);
    const elapsed = performance.now() - started;
    operationLatency.push(elapsed);
    (workloadLatency[workload.name] ??= []).push(elapsed);
    increment(workloadCounts, workload.name);
    operations += 1;
    iteration += 1;
  }
}

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => worker(index)),
);
ws.close(1000, "LOAD_COMPLETE");
subscription.closedAt = new Date().toISOString();

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}

const elapsedMs = Date.now() - startedAt;
const report = {
  sloDefinedBeforeRun: {
    unexpectedErrorRate: "<1%",
    authenticationFailures: 0,
    unauthorizedDataExposures: 0,
    unboundedRetryLoops: 0,
    unhandledProcessErrors: 0,
    ordinaryReadP95Ms: ordinaryReadP95TargetMs,
    mixedOperationP99Ms: mixedOperationP99TargetMs,
    subscriptionUpdateP99Ms: subscriptionUpdateP99TargetMs,
  },
  configuration: {
    durationMs,
    concurrency,
    targetOperationsPerSecond,
    ports,
    tenant,
    ontology,
    workloadNames: workloads.map(({ name }) => name),
    clientRetries: false,
  },
  result: {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    elapsedMs,
    operations,
    httpRequests,
    achievedOperationsPerSecond: operations / (elapsedMs / 1_000),
    achievedHttpRequestsPerSecond: httpRequests / (elapsedMs / 1_000),
    unexpectedFailures,
    expectedRateLimits,
    unexpectedErrorRate:
      httpRequests === 0 ? 0 : unexpectedFailures / httpRequests,
    requestLatencyMs: percentiles(requestLatency),
    operationLatencyMs: percentiles(operationLatency),
    maxObservedConcurrency: maxActive,
    statusCounts,
    errorNameCounts,
    workloadCounts,
    workloadLatencyMs: Object.fromEntries(
      Object.entries(workloadLatency).map(([name, values]) => [
        name,
        percentiles(values),
      ]),
    ),
    nodeCounts,
    subscription,
  },
  representativeFailures: samples,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, { mode: 0o600 });
process.stdout.write(serialized);
