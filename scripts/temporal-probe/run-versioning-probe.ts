#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// run-versioning-probe — EMPIRICAL answer to "what do queue Build-ID rules
// actually gate on server 1.25.2 + SDK 1.16?". Deterministic: every phase
// writes receipts to --out <dir> and summarizes to <out>/report.json; the
// test lane (tests/unit/funnel/workerVersioning-* or the integration lane)
// asserts from the receipts.
//
// Phases:
//   baseline   — workers probe-a + probe-b (both versioned), NO rules:
//                records who executes wf0 (documents default transparency).
//   assignment — rule probe-a@100: wf1 must be executed by probe-a.
//   upgrade    — rule switched to probe-b@100 + redirect probe-a→probe-b:
//                wf2 must be executed by probe-b (compatible rollout).
//   foreign    — worker probe-c (unknown build) polling while wf3 executes:
//                wf3 is routed by the probe-b rule; receipts show whether a
//                build WITHOUT a routing rule ever claims work.
//   rollback   — assignment index-0 back to probe-a: wf4 → probe-a.
//   replay     — Worker.runReplayHistory over every captured history —
//                the deterministic replay gate for new worker binaries.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { spawnSync, spawn, type ChildProcess } from "child_process";
import { Client, Connection } from "@temporalio/client";
import { Worker } from "@temporalio/worker";


interface Flags { queue: string; namespace: string; out: string; }
function parseFlags(): Flags {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  return {
    // Run-unique queue: rules of a PREVIOUS probe execution are invisible
    // (and would otherwise poison this run via "NewerBuildExists" rejects).
    queue: get("queue", `funniso-versioning-probe-${Date.now()}`),
    namespace: get("namespace", "default"),
    out: get("out", "/tmp/versioning-probe"),
  };
}

function temporalCli(args: string[]): string {
  const host = spawnSync("temporal", ["--version"], { encoding: "utf8" });
  if (host.status === 0) {
    const r = spawnSync("temporal", ["--address", "localhost:7233", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`temporal ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return (r.stdout ?? "").toString();
  }
  const container = process.env.TEMPORAL_CLI_CONTAINER || "tellus-temporal-1";
  const r = spawnSync("docker", ["exec", container, "temporal", "--address", "temporal:7233", ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker exec temporal ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").toString();
}

interface Child { buildId: string; proc: ChildProcess; }

const buffers = new Map<string, string>();

function startWorker(f: Flags, buildId: string): Child {
  buffers.set(buildId, "");
  const proc = spawn(
    "npx",
    ["tsx", "scripts/temporal-probe/probeWorker.ts", "--build", buildId, "--queue", f.queue, "--namespace", f.namespace, "--out", f.out],
    { cwd: path.resolve(__dirname, "..", ".."), stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (d: Buffer) => {
    buffers.set(buildId, (buffers.get(buildId) ?? "") + d.toString());
    if (process.env.PROBE_VERBOSE) process.stderr.write(`[w:${buildId}] ${d}`);
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", (d: Buffer) => { if (process.env.PROBE_VERBOSE) process.stderr.write(`[w:${buildId}:err] ${d}`); });
  return { buildId, proc };
}

async function waitForReady(child: Child, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((buffers.get(child.buildId) ?? "").includes("probe_worker_ready")) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worker ${child.buildId} not ready in ${timeoutMs}ms`);
}

async function stopWorker(child: Child | null, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!child) return;
  child.proc.kill(signal);
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000);
    child.proc.on("exit", () => { clearTimeout(t); resolve(); });
  });
}

function readReceipts(out: string, buildId: string): string[] {
  const p = path.join(out, `${buildId}.log`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).wf as string);
}

async function ensureNamespace(client: Client, queue: string, namespace: string): Promise<void> {
  void client; void queue;
  try {
    const conn = client.connection;
    await conn.workflowService.describeNamespace({ namespace });
  } catch {
    await client.connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: { seconds: (86400 as unknown) as import("long") },
    });
  }
}

async function executeWorkflow(
  client: Client,
  workflowNamespace: string,
  queue: string,
  wfId: string,
  historyOutDir: string,
  timeoutMs = 90_000,
): Promise<void> {
  const handle = await client.workflow.start("versioningProbeWorkflow", {
    workflowId: wfId,
    taskQueue: queue,
    args: [{ wfId }],
    workflowExecutionTimeout: timeoutMs,
  });
  await handle.result();
  // Persist the canonical `temporal workflow show -o json` history — the
  // exact shape Worker.runReplayHistory understands (string eventIds +
  // protojson timestamps).
  const raw = temporalCli(["workflow", "show", "-n", workflowNamespace, "--workflow-id", wfId, "-o", "json"]);
  fs.writeFileSync(path.join(historyOutDir, `history-${wfId}.json`), raw);
}

const sleepAfterRule = async () => { await new Promise((r) => setTimeout(r, 5000)); };
function clearRules(queue: string, namespace: string): void {
  const out = temporalCli(["task-queue", "versioning", "get-rules", "-t", queue, "-n", namespace, "-o", "json"]);
  let parsed: { assignmentRules?: unknown[]; redirectRules?: unknown[] } = {};
  try { parsed = JSON.parse(out); } catch { return; }
  const nA = (parsed.assignmentRules ?? []).length;
  for (let i = nA - 1; i >= 0; i--) {
    temporalCli(["task-queue", "versioning", "delete-assignment-rule", "-t", queue, "-n", namespace, "--rule-index", String(i), "--force", "-y"]);
  }
  let rulesObj: { redirectRules?: { sourceBuildID?: string }[] } = {};
  try { rulesObj = JSON.parse(temporalCli(["task-queue", "versioning", "get-rules", "-t", queue, "-n", namespace, "-o", "json"])); } catch { return; }
  for (const r of rulesObj.redirectRules ?? []) {
    const src = r.sourceBuildID;
    if (src) temporalCli(["task-queue", "versioning", "delete-redirect-rule", "-t", queue, "-n", namespace, "--source-build-id", src, "-y"]);
  }
}

async function main(): Promise<void> {
  const flags = parseFlags();
  fs.mkdirSync(flags.out, { recursive: true });
  for (const b of ["probe-a", "probe-b", "probe-c"]) { try { fs.unlinkSync(path.join(flags.out, `${b}.log`)); } catch { /*absent*/ } }

  const conn = await Connection.connect({ address: "localhost:7233" });
  const client = new Client({ connection: conn, namespace: flags.namespace });
  await ensureNamespace(client, flags.queue, flags.namespace);
  clearRules(flags.queue, flags.namespace);

  const report: Record<string, unknown> = { queue: flags.queue, phases: {} };
  // PHASE 0 — baseline, no rules. A queue with NO routing rules has no
  // execution route for NEW runs by versioned pollers: wf0 MUST time out
  // with zero receipts on both builds. This is the intended fail-closed
  // default — queue routing is infrastructure-owned, never app-defaulted.
  let wa = startWorker(flags, "probe-a");
  let wb = startWorker(flags, "probe-b");
  await waitForReady(wa); await waitForReady(wb);
  let baselineTimedOut = false;
  let baselineError = "";
  try {
    await executeWorkflow(client, flags.namespace, flags.queue, "probe-wf0-baseline", flags.out, 30_000);
    baselineError = "<completed>";
  } catch (err) {
    baselineError = (err as Error).message;
    baselineTimedOut = /timed out|timeout/i.test(baselineError);
    // Timeouts leave no activity receipts and no completed history to
    // capture; the absence of receipts is the assertion below.
  }
  const baseline = {
    error: baselineError,
    timedOut: baselineTimedOut,
    receiptsA: readReceipts(flags.out, "probe-a").length,
    receiptsB: readReceipts(flags.out, "probe-b").length,
  };
  (report.phases as Record<string, unknown>).baseline = baseline;
  if (baseline.receiptsA !== 0 || baseline.receiptsB !== 0) {
    throw new Error("baseline violated: a versioned poller claimed work on a queue without routing rules");
  }
  await stopWorker(wb);

  // PHASE 1 — assignment rule: 100% of new executions → probe-a.
  temporalCli(["task-queue", "versioning", "insert-assignment-rule", "-t", flags.queue, "-n", flags.namespace, "--build-id", "probe-a", "--rule-index", "0", "--percentage", "100", "-y"]);
  await sleepAfterRule();
  await executeWorkflow(client, flags.namespace, flags.queue, "probe-wf1-assigned", flags.out);
  const p1a = readReceipts(flags.out, "probe-a").includes("probe-wf1-assigned");
  const p1b = readReceipts(flags.out, "probe-b").includes("probe-wf1-assigned");
  const rules1 = JSON.parse(temporalCli(["task-queue", "versioning", "get-rules", "-t", flags.queue, "-n", flags.namespace, "-o", "json"]) || "{}");
  (report.phases as Record<string, unknown>).assignment = { assignedToA: p1a, executedByB: p1b, rules: rules1 };
  await stopWorker(wa);

  // PHASE 2 — compatible rolling upgrade: rule → probe-b@100 + redirect a→b.
  clearRules(flags.queue, flags.namespace);
  temporalCli(["task-queue", "versioning", "insert-assignment-rule", "-t", flags.queue, "-n", flags.namespace, "--build-id", "probe-b", "--rule-index", "0", "--percentage", "100", "-y"]);
  temporalCli(["task-queue", "versioning", "add-redirect-rule", "-t", flags.queue, "-n", flags.namespace, "--source-build-id", "probe-a", "--target-build-id", "probe-b", "-y"]);
  await sleepAfterRule();
  wb = startWorker(flags, "probe-b");
  await waitForReady(wb);
  await executeWorkflow(client, flags.namespace, flags.queue, "probe-wf2-upgrade", flags.out);
  (report.phases as Record<string, unknown>).upgrade = {
    executedByB: readReceipts(flags.out, "probe-b").includes("probe-wf2-upgrade"),
  };

  // PHASE 3 — foreign build probe-c polls while wf3 executes under the
  // probe-b routing rule.
  const wc = startWorker(flags, "probe-c");
  await waitForReady(wc);
  await executeWorkflow(client, flags.namespace, flags.queue, "probe-wf3-foreign", flags.out);
  const foreignClaimed = readReceipts(flags.out, "probe-c").includes("probe-wf3-foreign");
  const ownerClaimed = readReceipts(flags.out, "probe-b").includes("probe-wf3-foreign");
  (report.phases as Record<string, unknown>).foreign = { foreignClaimedWork: foreignClaimed, routedWorkerClaimedWork: ownerClaimed };
  await stopWorker(wc);

  // PHASE 4 — rollback: first assignment slot back to probe-a.
  clearRules(flags.queue, flags.namespace);
  temporalCli(["task-queue", "versioning", "insert-assignment-rule", "-t", flags.queue, "-n", flags.namespace, "--build-id", "probe-a", "--rule-index", "0", "--percentage", "100", "-y"]);
  await sleepAfterRule();
  wa = startWorker(flags, "probe-a");
  await waitForReady(wa);
  await executeWorkflow(client, flags.namespace, flags.queue, "probe-wf4-rollback", flags.out);
  (report.phases as Record<string, unknown>).rollback = { executedByA: readReceipts(flags.out, "probe-a").includes("probe-wf4-rollback") };
  await stopWorker(wb);
  await stopWorker(wa);

  // PHASE 5 — replay every captured history against the current bundle.
  const replayResults: Record<string, string> = {};
  for (const wfId of ["probe-wf1-assigned", "probe-wf2-upgrade", "probe-wf3-foreign", "probe-wf4-rollback"]) {
    const hp = path.join(flags.out, `history-${wfId}.json`);
    if (!fs.existsSync(hp)) { replayResults[wfId] = "<missing>"; continue; }
    try {
      const raw = fs.readFileSync(hp, "utf8");
      const history = JSON.parse(raw);
      await Worker.runReplayHistory(
        { workflowsPath: require.resolve("./workflowBundle") } as never,
        history,
      );
      replayResults[wfId] = "replayed";
    } catch (err) {
      replayResults[wfId] = `FAILED: ${(err as Error).message}`;
    }
  }
  (report.phases as Record<string, unknown>).replay = replayResults;

  // Rule clean-up so subsequent probe runs re-start from a blank queue.
  clearRules(flags.queue, flags.namespace);
  fs.writeFileSync(path.join(flags.out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
