import { client } from "../opensearch/client";

// ---------------------------------------------------------------------------
// parallelBulkIndexer.ts (Phase 4: gaps 3 + 4)
//
// Concurrent, multi-batch OpenSearch bulk indexer with health-aware
// backpressure. Consumes an async iterable of pre-built, security-stamped
// docs (each carrying the bulk `_id` in `__pk`), batches them, and flushes
// `concurrency` batches in flight at once.
//
// Backpressure (gap 4): a rolling window of recent bulk outcomes (success
// vs transient-error + latency) drives the concurrency. Under elevated
// error-rate or latency (the signature of the dev OpenSearch container
// being pushed into its healthcheck timeout + autoheal restart), it backs
// off (fewer in-flight batches + a short delay); when healthy it ramps
// back up. This is what was MISSING when the old fixed-rate sequential
// firing pushed the cluster into the `ECONNRESET` restart loop.
//
// Idempotent (gap 3 enabler): the `index` action is keyed by `_id`, so a
// retried or concurrent batch overwrites safely — concurrency + retry
// can't double-index.
//
// `onProgress(indexedCount)` is called after each batch commits so the
// Phase 3 run can checkpoint `indexed_count` for resume.
// ---------------------------------------------------------------------------

export interface ParallelBulkOptions {
  indexName: string;
  /** Docs per bulk request. Default 2000 (env REINDEX_BULK_BATCH_DOCS). */
  batchSize?: number;
  /** Initial + target in-flight batches. Default 4. */
  concurrency?: number;
  /** Ceiling for ramp-up. Default 8. */
  maxConcurrency?: number;
  /** Per-bulk requestTimeout (ms). Default 60000. */
  requestTimeout?: number;
  /** Called after each batch commits with the running indexed count. */
  onProgress?: (indexedCount: number) => void | Promise<void>;
}

export interface ParallelBulkResult {
  indexedCount: number;
  errorItems: any[];
  peakConcurrency: number;
  finalConcurrency: number;
  retries: number;
}

const MAX_BULK_ATTEMPTS = 4;

// Classify transient (retry-worthy) vs permanent bulk errors.
function isTransientBulkError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  const code = String(err?.code ?? err?.name ?? "").toLowerCase();
  if (
    code === "es_connection_error" ||
    code === "response_timeout" ||
    code === "not_found_connection"
  ) return true;
  if (/epipe|econnreset|econnrefused|etimedout|socket hang up|write epipe|connection|timeout|reset by peer/.test(msg)) return true;
  const status: number | undefined =
    err?.meta?.statusCode ?? err?.statusCode ?? err?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function positiveInt(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Index a doc stream into OpenSearch with concurrent batches + health-aware
 * backpressure. Docs MUST carry `__pk` (used as the bulk `_id`) and be
 * already security-stamped + type-converted by the caller.
 */
export async function parallelBulkIndex(
  docs: AsyncIterable<Record<string, unknown>>,
  opts: ParallelBulkOptions,
): Promise<ParallelBulkResult> {
  const indexName = opts.indexName;
  const batchSize = opts.batchSize ?? positiveInt(process.env.REINDEX_BULK_BATCH_DOCS, 2000);
  const maxConcurrency = opts.maxConcurrency ?? 8;
  const requestTimeout = opts.requestTimeout ?? positiveInt(process.env.OPENSEARCH_BULK_REQUEST_TIMEOUT, 60_000);

  let concurrency = Math.min(opts.concurrency ?? 4, maxConcurrency);
  let indexedCount = 0;
  let retries = 0;
  let peakConcurrency = concurrency;
  const errorItems: any[] = [];

  // Rolling health window: last 20 bulk outcomes (true=ok, false=transient-err)
  // + their latencies. Drives the backpressure ramp.
  const WINDOW = 20;
  const outcomes: boolean[] = [];
  const latencies: number[] = [];

  const health = (): {stress: boolean; reason: string} => {
    if (outcomes.length < 5) return { stress: false, reason: "" };
    const errs = outcomes.filter((o) => !o).length;
    const errRate = errs / outcomes.length;
    const recent = latencies.slice(-WINDOW);
    const p95 = recent.length ? recent.sort((a, b) => a - b)[Math.floor(recent.length * 0.95)] : 0;
    if (errRate > 0.25) return { stress: true, reason: `errRate=${(errRate * 100).toFixed(0)}%` };
    if (p95 > 5_000) return { stress: true, reason: `p95=${p95}ms` };
    return { stress: false, reason: "" };
  };

  // PROACTIVE cluster-health probe (gap 4): the dev OpenSearch container's
  // autoheal recreates it when the healthcheck times out under GC/merge
  // pressure — which is ABRUPT (no preceding transient error for the reactive
  // window to catch). Probe the cluster JVM heap% periodically; if it's
  // elevated, force concurrency down BEFORE the healthcheck trips. This is
  // the difference between "react to the crash" and "don't cause the crash".
  let lastProbe = 0;
  let clusterStressed = false;
  const probeClusterHealth = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastProbe < 5_000) return; // at most every 5s
    lastProbe = now;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 2_000);
      const res = await fetch(
        "http://localhost:9200/_nodes/stats/jvm?filter_path=nodes.*.jvm.mem.heap_used_percent",
        { signal: ctrl.signal },
      );
      clearTimeout(tid);
      if (!res.ok) { clusterStressed = true; return; }
      const j: any = await res.json();
      const nodes = Object.values(j.nodes || {}) as any[];
      const maxHeap = nodes.reduce((m, n) => Math.max(m, n?.jvm?.mem?.heap_used_percent ?? 0), 0);
      clusterStressed = maxHeap > 75; // back off when any node crosses 75% heap
    } catch {
      // Probe failed (cluster unreachable mid-restart) → treat as stressed.
      clusterStressed = true;
    }
  };

  // Flush one batch (with per-batch transient retry). Idempotent → retry safe.
  const flush = async (batch: Record<string, unknown>[]): Promise<void> => {
    if (batch.length === 0) return;
    let result: any;
    for (let attempt = 1; attempt <= MAX_BULK_ATTEMPTS; attempt++) {
      const t0 = Date.now();
      try {
        result = await client.bulk(
          { body: batch, refresh: false },
          { requestTimeout },
        );
        const ms = Date.now() - t0;
        // Per-item outcome: 200/201 = ok; collect per-item 4xx into errorItems.
        const items: any[] = result?.body?.items || [];
        let batchOk = true;
        for (const item of items) {
          if (item.index?.status === 200 || item.index?.status === 201) {
            indexedCount++;
          } else if (item.index?.error) {
            batchOk = false;
            if (errorItems.length < 10) errorItems.push(item.index.error);
          }
        }
        outcomes.push(batchOk);
        latencies.push(ms);
        if (outcomes.length > WINDOW) outcomes.shift();
        if (latencies.length > WINDOW) latencies.shift();
        break;
      } catch (err: any) {
        const ms = Date.now() - t0;
        outcomes.push(false);
        latencies.push(ms);
        if (outcomes.length > WINDOW) outcomes.shift();
        if (latencies.length > WINDOW) latencies.shift();
        if (isTransientBulkError(err) && attempt < MAX_BULK_ATTEMPTS) {
          retries++;
          // Back off: under stress, drop concurrency + wait before retry.
          const h = health();
          if (h.stress && concurrency > 1) concurrency--;
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw err;
      }
    }
    if (opts.onProgress) await opts.onProgress(indexedCount);
  };

  // Bounded-concurrency pool: accumulate docs into a pending batch; submit
  // a flush promise when a batch fills; keep at most `concurrency` flushes
  // in flight. Health-aware: before submitting, check stress and back off.
  let pending: Record<string, unknown>[] = [];
  const inFlight: Promise<void>[] = [];

  for await (const doc of docs) {
    pending.push({ index: { _index: indexName, _id: doc.__pk } });
    pending.push(doc);
    if (pending.length / 2 >= batchSize) {
      // Health-aware gate before submitting a new batch. Both the reactive
      // window (error-rate/p95) AND the proactive cluster-heap probe feed it;
      // either being stressed backs off BEFORE submitting the next batch.
      await probeClusterHealth();
      const h = health();
      const stressed = h.stress || clusterStressed;
      if (stressed) {
        if (concurrency > 1) {
          concurrency--;
        } else {
          // At concurrency=1 + stressed — pace to ease cluster load (avoid
          // the healthcheck-timeout → autoheal recreate that wiped the index).
          await new Promise((r) => setTimeout(r, 300));
        }
      } else if (concurrency < maxConcurrency && outcomes.length >= 10 && outcomes.slice(-10).every((o) => o)) {
        // Healthy sustained → ramp up.
        concurrency++;
      }
      if (concurrency > peakConcurrency) peakConcurrency = concurrency;

      // Respect the concurrency ceiling: if at capacity, await one flush.
      while (inFlight.length >= concurrency) {
        await Promise.race(inFlight);
      }
      const batch = pending; pending = [];
      const p = flush(batch).finally(() => {
        const idx = inFlight.indexOf(p);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(p);
    }
  }
  // Flush trailing partial batch.
  if (pending.length > 0) {
    const p = flush(pending).finally(() => {
      const idx = inFlight.indexOf(p);
      if (idx >= 0) inFlight.splice(idx, 1);
    });
    inFlight.push(p);
  }
  await Promise.all(inFlight);

  return { indexedCount, errorItems, peakConcurrency, finalConcurrency: concurrency, retries };
}
