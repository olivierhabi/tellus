// ---------------------------------------------------------------------------
// Overlay SLIs — Task B7
//
// The overlay is correctness-critical, so we track one SLI as a
// first-class signal:
//
//   overlay_to_index_lag  — time between overlay write and Quickwit
//                           publishing a split that includes the edit
//
// The implementation is a bounded ring buffer of per-edit timestamps so we
// can compute p50/p99 without pulling in a full histogram library. A single
// process is fine for this signal — we export the snapshot via
// getOverlaySloSnapshot() for a health route / Prometheus bridge to read.
// ---------------------------------------------------------------------------

interface EditTimestamps {
  editId: string;
  overlayAt: number;
  indexedAt?: number;
}

const RING_CAPACITY = 10_000;
const ring: EditTimestamps[] = [];
const byEditId = new Map<string, EditTimestamps>();

let droppedForCapacity = 0;

export function recordOverlayWrite(editId: string, overlayAt: number): void {
  const existing = byEditId.get(editId);
  if (existing) {
    existing.overlayAt = overlayAt;
    return;
  }
  const entry: EditTimestamps = { editId, overlayAt };
  ring.push(entry);
  byEditId.set(editId, entry);
  if (ring.length > RING_CAPACITY) {
    const evicted = ring.shift()!;
    byEditId.delete(evicted.editId);
    droppedForCapacity++;
  }
}

export function recordIndexApplied(editId: string, indexedAt: number = Date.now()): void {
  const entry = byEditId.get(editId);
  if (!entry) return; // edit wasn't tracked (process restart etc.)
  entry.indexedAt = indexedAt;
}

export interface OverlaySloSnapshot {
  /** How many edits we currently track. */
  tracked: number;
  /** Edits still waiting for their Quickwit publish. */
  pending: number;
  /** Edits already correlated with a Quickwit publish. */
  resolved: number;
  /** Dropped for ring-buffer capacity. */
  droppedForCapacity: number;
  /** Latency stats in milliseconds over resolved entries. */
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** True when p99Ms > 60_000 (page condition from the spec). */
  alerting: boolean;
}

export function getOverlaySloSnapshot(): OverlaySloSnapshot {
  const latencies: number[] = [];
  let pending = 0;
  for (const e of ring) {
    if (typeof e.indexedAt === "number") {
      latencies.push(Math.max(0, e.indexedAt - e.overlayAt));
    } else {
      pending++;
    }
  }
  latencies.sort((a, b) => a - b);
  const p50 = quantile(latencies, 0.5);
  const p99 = quantile(latencies, 0.99);
  const max = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  return {
    tracked: ring.length,
    pending,
    resolved: latencies.length,
    droppedForCapacity,
    p50Ms: p50,
    p99Ms: p99,
    maxMs: max,
    alerting: p99 > 60_000,
  };
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * sortedAsc.length))
  );
  return sortedAsc[idx];
}

export function __resetOverlaySlisForTesting(): void {
  ring.length = 0;
  byEditId.clear();
  droppedForCapacity = 0;
}

// ---------------------------------------------------------------------------
// Prometheus exposition — B7 SLI (`overlay_to_index_lag_p99`) as a
// first-class signal. Emits the minimal text format so a scrape endpoint
// (route or sidecar) can serve it directly without pulling in prom-client.
// ---------------------------------------------------------------------------

export function renderOverlaySliPrometheus(
  snapshot: OverlaySloSnapshot = getOverlaySloSnapshot()
): string {
  const lines = [
    "# HELP overlay_to_index_lag_p50_seconds Median overlay→index latency.",
    "# TYPE overlay_to_index_lag_p50_seconds gauge",
    `overlay_to_index_lag_p50_seconds ${(snapshot.p50Ms / 1000).toFixed(3)}`,
    "# HELP overlay_to_index_lag_p99_seconds 99th pct overlay→index latency. Page when >60.",
    "# TYPE overlay_to_index_lag_p99_seconds gauge",
    `overlay_to_index_lag_p99_seconds ${(snapshot.p99Ms / 1000).toFixed(3)}`,
    "# HELP overlay_to_index_lag_max_seconds Max observed overlay→index latency.",
    "# TYPE overlay_to_index_lag_max_seconds gauge",
    `overlay_to_index_lag_max_seconds ${(snapshot.maxMs / 1000).toFixed(3)}`,
    "# HELP overlay_edits_pending Edits with an overlay write but no indexed confirmation.",
    "# TYPE overlay_edits_pending gauge",
    `overlay_edits_pending ${snapshot.pending}`,
    "# HELP overlay_edits_resolved Edits for which the indexing stage has stamped applied_to_index_at.",
    "# TYPE overlay_edits_resolved gauge",
    `overlay_edits_resolved ${snapshot.resolved}`,
    "# HELP overlay_slo_alerting 1 if p99 lag exceeds the 60s page threshold.",
    "# TYPE overlay_slo_alerting gauge",
    `overlay_slo_alerting ${snapshot.alerting ? 1 : 0}`,
  ];
  return lines.join("\n") + "\n";
}
