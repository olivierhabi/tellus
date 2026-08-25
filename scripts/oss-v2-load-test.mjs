#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const baseUrl = process.env.TELLUS_BASE_URL ?? "http://127.0.0.1:3000";
const ontology =
  process.env.TELLUS_ONTOLOGY_ID ??
  "00000000-0000-0000-0000-000000000001";
const token =
  process.env.TELLUS_TOKEN ??
  (await readFile("/tmp/tellus-token", "utf8")).trim();
const durationMs = Number(process.env.DURATION_MS ?? 15_000);
const concurrency = Number(process.env.CONCURRENCY ?? 12);
const snapshot = process.env.SNAPSHOT === "true";
const transactionId = process.env.TRANSACTION_ID ?? null;
const scenarioRid = process.env.SCENARIO_RID ?? null;
const latencies = [];
const statusCounts = new Map();
let completed = 0;
let failed = 0;

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

async function load(context) {
  const query = new URLSearchParams();
  if (context?.transactionId) query.set("transactionId", context.transactionId);
  if (context?.scenarioRid) query.set("scenarioRid", context.scenarioRid);
  const started = performance.now();
  try {
    const response = await fetch(
      `${baseUrl}/api/v2/ontologies/${ontology}/objectSets/loadObjects?${query}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          objectSet: { type: "base", objectType: "Taxpayer" },
          pageSize: 25,
          select: ["tin", "fullName", "district"],
          orderBy: {
            fields: [{ field: "tin", direction: "asc" }],
          },
          ...(snapshot ? { snapshot: true } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    await response.arrayBuffer();
    const elapsed = performance.now() - started;
    latencies.push(elapsed);
    statusCounts.set(
      response.status,
      (statusCounts.get(response.status) ?? 0) + 1,
    );
    completed += 1;
    if (!response.ok) failed += 1;
  } catch {
    latencies.push(performance.now() - started);
    failed += 1;
    completed += 1;
    statusCounts.set("transport", (statusCounts.get("transport") ?? 0) + 1);
  }
}

const contexts = [
  null,
  ...(transactionId ? [{ transactionId }] : []),
  ...(scenarioRid ? [{ scenarioRid }] : []),
];
const deadline = performance.now() + durationMs;
let nextContext = 0;
const workers = Array.from({ length: concurrency }, async () => {
  while (performance.now() < deadline) {
    const context = contexts[nextContext++ % contexts.length];
    await load(context);
  }
});
const wallStarted = performance.now();
await Promise.all(workers);
const wallMs = performance.now() - wallStarted;

console.log(
  JSON.stringify(
    {
      baseUrl,
      ontology,
      durationMs: Math.round(wallMs),
      concurrency,
      snapshot,
      contexts: contexts.map((context) =>
        context ? Object.keys(context)[0] : "base",
      ),
      completed,
      failed,
      errorRate: completed === 0 ? null : failed / completed,
      throughputPerSecond: completed / (wallMs / 1000),
      latencyMs: {
        min: latencies.length ? Math.min(...latencies) : null,
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
        max: latencies.length ? Math.max(...latencies) : null,
      },
      statusCounts: Object.fromEntries(statusCounts),
    },
    null,
    2,
  ),
);
