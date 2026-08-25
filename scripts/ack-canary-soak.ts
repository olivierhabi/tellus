/* ---------------------------------------------------------------------------
 * scripts/ack-canary-soak.ts — Canary soak + SLO capture for
 * LINK_INDEX_ACK_REQUIRED (final-run).
 *
 * Drives sustained /apply traffic against a flag-ON canary server, polls the
 * statusUrl of sampled 202'd executions (catch-up signal), forces a couple
 * of ReplacingMergeTree merges mid-soak to exercise absorption, and snapshots
 * the 5 SLO metrics on /api/v1/funnel/metrics at start and end. Writes a JSON
 * summary to SOAK_OUT (default /tmp/ack-canary-soak-summary.json).
 *
 * Reads from env: SOAK_TOKEN (required), SOAK_PORT (3017), SOAK_SECONDS (1800),
 * SOAK_TARGET (1000), SOAK_CONCURRENCY (5), SOAK_OUT (path), SOAK_CH_OPTIMIZE
 * (default "true" — forces 2 OPTIMIZE FINAL merges at ~33%/66% wall elapsed).
 *
 * Tempo/quality probe — does NOT tune the topology: a p99 blown target is
 * reported, not fixed.
 * ------------------------------------------------------------------------- */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
loadEnv();

const PORT = process.env.SOAK_PORT ?? "3017";
const ONT = "00000000-0000-0000-0000-000000000001";
const ACTION = "ackmanual-link-adder";
const BASE = `http://localhost:${PORT}`;
const TOKEN = process.env.SOAK_TOKEN;
const MAX_SECONDS = Number(process.env.SOAK_SECONDS ?? 1800);
const TARGET_EXECS = Number(process.env.SOAK_TARGET ?? 1000);
const CONCURRENCY = Number(process.env.SOAK_CONCURRENCY ?? 5);
const OUT = process.env.SOAK_OUT ?? "/tmp/ack-canary-soak-summary.json";
const DO_OPTIMIZE = process.env.SOAK_CH_OPTIMIZE !== "false";
const CH_TABLE = "default.link__ackmanualsrc__ackmanualownedby__ackmanualtgt";

if (!TOKEN) {
  console.error("SOAK_TOKEN env var required (mint a Keycloak access token).");
  process.exit(2);
}

// Hot-edge (force merge contention) + fresh-pair rotation.
const HOT_EDGE = { s: "m-s-1", t: "m-t-1" };
const PAIRS = [
  { s: "m-s-1", t: "m-t-1" },
  { s: "m-s-2", t: "m-t-2" },
  { s: "m-s-1", t: "m-t-2" },
  { s: "m-s-2", t: "m-t-1" },
];

interface ApplyBody {
  executionId?: string;
  result?: string;
  durationMs?: number;
  linkIndexAck?: { confirmed?: boolean; reason?: string };
  [k: string]: unknown;
}

async function applyOne(pair: { s: string; t: string }): Promise<{
  status: number; executionId?: string; confirmed?: boolean; reason?: string; result?: string; clkMs: number;
}> {
  const t0 = Date.now();
  const resp = await fetch(
    `${BASE}/api/v1/ontology/${ONT}/actions/${ACTION}/apply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ parameters: { sourcePk: pair.s, targetPk: pair.t } }),
    },
  );
  const text = await resp.text();
  let body: ApplyBody = {};
  try { body = JSON.parse(text) as ApplyBody; } catch { /* swallow */ }
  return {
    status: resp.status,
    executionId: body.executionId,
    confirmed: body.linkIndexAck?.confirmed,
    reason: body.linkIndexAck?.reason,
    result: body.result,
    clkMs: Date.now() - t0,
  };
}

async function pollOnce(executionId: string): Promise<{ status: number; indexVisibility?: string; clkMs: number }> {
  const t0 = Date.now();
  const resp = await fetch(`${BASE}/api/v1/audit/log/${executionId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await resp.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* swallow */ }
  return { status: resp.status, indexVisibility: body?.indexVisibility, clkMs: Date.now() - t0 };
}

async function scrape(): Promise<string> {
  const r = await fetch(`${BASE}/api/v1/funnel/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return r.ok ? await r.text() : "";
}

function histoBucketCount(text: string, name: string, edge: string): number {
  const e = edge === "+Inf" ? "\\+Inf" : edge;
  const bm = text.match(new RegExp(`^${name}_bucket\\{[^}]*le="${e}"[^}]*\\}\\s+(\\d+)`, "m"));
  return bm ? Number(bm[1]) : 0;
}
function histoCount(text: string, name: string): number {
  return numMatch(text, new RegExp(`^${name}_count\\b[^\\n]*\\s+(\\d+)`, "m"));
}

function histoP(text: string, name: string, p: number): number | null {
  const n = histoCount(text, name);
  if (n === 0) return null;
  const target = n * p;
  const edges = ["0.1", "0.5", "1", "2", "5", "10", "30", "60", "120", "300", "600", "1800", "3600", "+Inf"];
  for (const e of edges) {
    if (histoBucketCount(text, name, e) >= target) return Number(e === "+Inf" ? 3600 : e);
  }
  return null;
}

/** Per-window (delta) p50/p99 of a histogram between two snapshots.
 *  Subtract cumulative bucket counts; iterate edges to find the one whose
 *  delta cumulative count crosses p × delta_total_n. Returns the edge in
 *  seconds (upper-bound) or null if the window produced no samples. */
function histoPDelta(before: string, after: string, name: string, p: number): number | null {
  const nBefore = histoCount(before, name);
  const nAfter = histoCount(after, name);
  const nDelta = nAfter - nBefore;
  if (nDelta <= 0) return null;
  const target = nDelta * p;
  const edges = ["0.1", "0.5", "1", "2", "5", "10", "30", "60", "120", "300", "600", "1800", "3600", "+Inf"];
  for (const e of edges) {
    const d = histoBucketCount(after, name, e) - histoBucketCount(before, name, e);
    if (d >= target) return Number(e === "+Inf" ? 3600 : e);
  }
  return null;
}

function numMatch(text: string, re: RegExp): number {
  return Number(text.match(re)?.[1] ?? 0);
}

function optimizeFinal(): void {
  try {
    execSync(`docker exec tellus-clickhouse-1 clickhouse-client --query "OPTIMIZE TABLE ${CH_TABLE} FINAL"`, { stdio: "ignore" });
  } catch (e) { console.error("[soak] optimize failed:", (e as Error).message); }
}

function ms(s: number): string { return `${Math.round(s / 1000)}s`; }

interface State {
  execCount: number;
  confirmed200: number;
  deferred202: number;
  applyLatencies: number[];
  pollQueue: string[];
  pollSamples: Array<{ executionId: string; pollTry: number; verdict: string; ms: number }>;
  optimizeCount: number;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const state: State = {
    execCount: 0, confirmed200: 0, deferred202: 0, applyLatencies: [],
    pollQueue: [], pollSamples: [], optimizeCount: 0,
  };
  const metricsBeforeText = await scrape();
  const stickyFailuresBefore = numMatch(metricsBeforeText, /^link_index_sticky_write_failures_total\s+(\d+)/m);
  console.log(`[soak] start | port=${PORT} max=${MAX_SECONDS}s target=${TARGET_EXECS} concurrency=${CONCURRENCY} optimize=${DO_OPTIMIZE}`);

  let lastProgress = 0;
  // Drive until BOTH the wall-floor AND the exec-count floor are met
  // (whichever is LONGER per the canary spec). Stop on either with a small
  // overshoot only when both tips clear — wrap-up.
  let lastCheck = Date.now();
  while (Date.now() - t0 < MAX_SECONDS * 1000 || state.execCount < TARGET_EXECS) {
    // drive CONCURRENCY applies in parallel:
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      // ~40% hot-edge (merge pressure) / rotation
      const pair = Math.random() < 0.4 ? HOT_EDGE : PAIRS[Math.floor(Math.random() * PAIRS.length)];
      const r = await applyOne(pair);
      state.execCount += 1;
      state.applyLatencies.push(r.clkMs);
      if (r.status === 200 && r.confirmed) state.confirmed200 += 1;
      else if (r.status === 202) state.deferred202 += 1;
      if (r.status === 202 && r.executionId && Math.random() < 0.2) state.pollQueue.push(r.executionId);
    }));

    // periodic OPTIMIZE_FINAL merges (twice across the soak):
    if (DO_OPTIMIZE) {
      const frac = (Date.now() - t0) / (MAX_SECONDS * 1000);
      if ((frac > 0.34 && state.optimizeCount < 1) || (frac > 0.67 && state.optimizeCount < 2)) {
        optimizeFinal();
        state.optimizeCount += 1;
        console.log(`[soak] OPTIMIZE FINAL #${state.optimizeCount} at ${ms(Date.now() - t0)} elapsed`);
      }
    }

    // pump pending polls (one per main-loop tick):
    if (state.pollQueue.length > 0) {
      const id = state.pollQueue.shift()!;
      const p = await pollOnce(id);
      state.pollSamples.push({ executionId: id, pollTry: state.pollSamples.length, verdict: p.indexVisibility ?? "??", ms: p.clkMs });
    }

    // progress every 60s:
    if (Date.now() - lastProgress > 60_000) {
      console.log(`[soak] execs=${state.execCount} confirmed=${state.confirmed200} deferred=${state.deferred202} elapsed=${ms(Date.now() - t0)} qLen=${state.pollQueue.length} stickyΔ=...`);
      lastProgress = Date.now();
    }
    // Safety: if wall has expired WAY past MAX_SECONDS AND execs >= TARGET, stop:
    if (Date.now() - t0 >= MAX_SECONDS * 1000 && state.execCount >= TARGET_EXECS) break;
    // If we've blown 2x the wall (sanity cap), stop:
    if (Date.now() - t0 >= 2 * MAX_SECONDS * 1000) break;
    // Throttle to avoid burning API much faster than we can poll:
    if (Date.now() - lastCheck > 100) await new Promise((r) => setTimeout(r, 50));
    lastCheck = Date.now();
  }

  const metricsAfterText = await scrape();
  const stickyFailuresAfter = numMatch(metricsAfterText, /^link_index_sticky_write_failures_total\s+(\d+)/m);

  state.applyLatencies.sort((a, b) => a - b);
  const applyP50 = state.applyLatencies[Math.floor(state.applyLatencies.length / 2)] ?? 0;
  const applyP99 = state.applyLatencies[Math.floor(state.applyLatencies.length * 0.99)] ?? 0;

  const commitP50 = histoPDelta(metricsBeforeText, metricsAfterText, "link_index_commit_to_queryable_seconds", 0.5);
  const commitP99 = histoPDelta(metricsBeforeText, metricsAfterText, "link_index_commit_to_queryable_seconds", 0.99);
  const pollP50 = histoPDelta(metricsBeforeText, metricsAfterText, "status_url_poll_seconds", 0.5);
  const pollP99 = histoPDelta(metricsBeforeText, metricsAfterText, "status_url_poll_seconds", 0.99);
  const outcome200 = numMatch(metricsAfterText, /link_index_ack_outcome_total\{result="200_confirmed"\}\s+(\d+)/);
  const outcome202 = numMatch(metricsAfterText, /link_index_ack_outcome_total\{result="202_deferred"\}\s+(\d+)/);
  const attempts = numMatch(metricsAfterText, /^link_index_ack_attempts_total\s+(\d+)/m);
  const timeoutDeferred = numMatch(metricsAfterText, /^link_index_ack_deferred_total\{reason="timeout"\}\s+(\d+)/m);
  const outageDeferred = numMatch(metricsAfterText, /^link_index_ack_deferred_total\{reason="index_outage"\}\s+(\d+)/m);

  const summary = {
    ranFor_s: Math.floor((Date.now() - t0) / 1000),
    canaryConfig: {
      LINK_INDEX_ACK_REQUIRED: "true",
      SERVING_STORE_MODE: "indexed",
      LINK_INDEX_ACK_TIMEOUT_MS: 5000,
      MAX_REQUEST_BUDGET_MS: 120000,
      PORT,
    },
    applyTraffic: {
      totalApplies: state.execCount,
      confirmed200: state.confirmed200,
      deferred202: state.deferred202,
      applyWallP50_ms: applyP50,
      applyWallP99_ms: applyP99,
      optimizeForcedCount: state.optimizeCount,
    },
    SLOs: {
      commit_to_queryable_p50_s: commitP50,
      commit_to_queryable_p99_s: commitP99,
      status_url_poll_p50_s: pollP50,
      status_url_poll_p99_s: pollP99,
      rate_202: outcome200 + outcome202 === 0 ? null : outcome202 / (outcome202 + outcome200),
      rate_ack_timeout: attempts === 0 ? null : timeoutDeferred / attempts,
      rate_ack_outage: attempts === 0 ? null : outageDeferred / attempts,
      ack_attempts_total: attempts,
      ack_deferred_timeout_total: timeoutDeferred,
      ack_deferred_outage_total: outageDeferred,
      outcome_200_confirmed: outcome200,
      outcome_202_deferred: outcome202,
      sticky_write_failures_delta: stickyFailuresAfter - stickyFailuresBefore,
      sticky_write_failures_before: stickyFailuresBefore,
      sticky_write_failures_after: stickyFailuresAfter,
    },
    pollSamples: state.pollSamples.slice(-12),
    targets: {
      commit_to_queryable_p99_s: 1.5,
      status_url_poll_p99_s: 1.5,
      sticky_write_failures_delta: 0,
    },
    notice: "p50/p99 from cumulative Prometheus histogram bucket counts (upper edge). Stops when MAX_SECONDS wall floor AND TARGET_EXECS exec floor are both met.",
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`[soak] DONE execs=${state.execCount} confirmed=${state.confirmed200} deferred=${state.deferred202} elapsed=${ms(Date.now() - t0)} stickyΔ=${stickyFailuresAfter - stickyFailuresBefore}`);
  console.log(`[soak] summary → ${OUT}`);
}

main().catch((e) => { console.error("[soak] FATAL", e); process.exit(1); });
