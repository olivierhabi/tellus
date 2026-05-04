// Workshop / G-04 — Prometheus metrics surface.
//
// Spec §B01 names the metrics this module emits:
//   tellus_workshop_module_load_seconds{result}            histogram
//   tellus_workshop_module_save_seconds{result}            histogram
//   tellus_workshop_module_create_seconds{result}          histogram
//   tellus_workshop_module_delete_seconds{result}          histogram
//   tellus_workshop_module_list_seconds                    histogram
//   tellus_workshop_module_etag_mismatch_total             counter
//   tellus_workshop_module_size_bytes                      histogram
//
// §0.4: histograms `_seconds`, counters `_total`, gauges no suffix; per-RID
// labels are forbidden — `result` is low-cardinality (`success`|`error`).
//
// prom-client is lazily required — same pattern as
// `auditEventService.ts`. If unavailable (test env), the module degrades
// to no-ops and the timer/incs become free.

type LabelValues = Record<string, string | number>;

interface HistogramHandle {
  observe(labels: LabelValues, value: number): void;
}

interface CounterHandle {
  inc(labels?: LabelValues, n?: number): void;
}

// Minimal local view of prom-client to avoid a hard import dep — the
// real package may or may not be installed (auditEventService.ts uses
// the same lazy-require pattern).
interface PromClient {
  Histogram: new (cfg: {
    name: string;
    help: string;
    labelNames?: string[];
    buckets?: number[];
  }) => HistogramHandle;
  Counter: new (cfg: {
    name: string;
    help: string;
    labelNames?: string[];
  }) => CounterHandle;
  register: {
    getSingleMetric(name: string): unknown;
  };
}

let prom: PromClient | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  prom = require("prom-client") as PromClient;
} catch {
  prom = null;
}

function makeHist(
  name: string,
  help: string,
  labelNames: string[],
  buckets?: number[],
): HistogramHandle {
  if (!prom) {
    return { observe: () => undefined };
  }
  // Idempotent registration — tests load this module multiple times and the
  // default registry rejects duplicate names.
  const existing = prom.register.getSingleMetric(name);
  if (existing) {
    return existing as unknown as HistogramHandle;
  }
  return new prom.Histogram({
    name,
    help,
    labelNames,
    buckets:
      buckets ??
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  }) as unknown as HistogramHandle;
}

function makeCounter(
  name: string,
  help: string,
  labelNames: string[] = [],
): CounterHandle {
  if (!prom) {
    return { inc: () => undefined };
  }
  const existing = prom.register.getSingleMetric(name);
  if (existing) {
    return existing as unknown as CounterHandle;
  }
  return new prom.Counter({ name, help, labelNames }) as unknown as CounterHandle;
}

export const histLoad = makeHist(
  "tellus_workshop_module_load_seconds",
  "Wall-clock seconds for GET /api/v1/workshop/modules/{rid}.",
  ["result"],
);
export const histSave = makeHist(
  "tellus_workshop_module_save_seconds",
  "Wall-clock seconds for PUT /api/v1/workshop/modules/{rid}.",
  ["result"],
);
export const histCreate = makeHist(
  "tellus_workshop_module_create_seconds",
  "Wall-clock seconds for POST /api/v1/workshop/modules.",
  ["result"],
);
export const histDelete = makeHist(
  "tellus_workshop_module_delete_seconds",
  "Wall-clock seconds for DELETE /api/v1/workshop/modules/{rid}.",
  ["result"],
);
export const histList = makeHist(
  "tellus_workshop_module_list_seconds",
  "Wall-clock seconds for GET /api/v1/workshop/modules?...",
  [],
);
export const counterEtagMismatch = makeCounter(
  "tellus_workshop_module_etag_mismatch_total",
  "Count of PUT requests rejected with 412 ResourceVersionMismatch.",
);
export const histSizeBytes = makeHist(
  "tellus_workshop_module_size_bytes",
  "Size in bytes of the persisted `definition` JSONB on write.",
  [],
  [512, 4096, 32_768, 131_072, 524_288, 1_048_576, 2_097_152],
);

/**
 * Start a timer; the returned function records the elapsed seconds with
 * the given `result` label.
 */
export function startTimer(
  hist: HistogramHandle,
): (result: "success" | "error") => void {
  const t0 = process.hrtime.bigint();
  return (result) => {
    const ns = Number(process.hrtime.bigint() - t0);
    hist.observe({ result }, ns / 1e9);
  };
}

export function startTimerNoLabel(
  hist: HistogramHandle,
): () => void {
  const t0 = process.hrtime.bigint();
  return () => {
    const ns = Number(process.hrtime.bigint() - t0);
    hist.observe({}, ns / 1e9);
  };
}

// ---- B02 — Validator metrics ----------------------------------------------

export const histValidate = makeHist(
  "tellus_workshop_validate_seconds",
  "Wall-clock seconds for in-process module validation (B02).",
  ["result"],
  // CPU-bound, target P95 ≤ 80ms — narrower buckets than the default.
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.08, 0.1, 0.25, 0.5, 1],
);
export const counterValidate = makeCounter(
  "tellus_workshop_validate_total",
  "Count of B02 validation invocations.",
  ["result"],
);

// ---- B03 — Publish + resolve metrics --------------------------------------

export const histPublish = makeHist(
  "tellus_workshop_publish_seconds",
  "Wall-clock seconds for POST /modules/{rid}:publish (B03).",
  ["result"],
);
export const histResolve = makeHist(
  "tellus_workshop_resolve_seconds",
  "Wall-clock seconds for GET /modules/{rid}/resolve/{latest|dev}.",
  ["track", "cache_hit"],
  [0.001, 0.005, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.25, 0.5, 1],
);
export const counterResolveCacheHit = makeCounter(
  "tellus_workshop_resolve_cache_hit_total",
  "Number of resolve calls served from the in-process TTL cache.",
  ["track"],
);
export const counterResolve = makeCounter(
  "tellus_workshop_resolve_total",
  "Total count of resolve calls.",
  ["track", "result"],
);

// ---- B05 — Object set load -------------------------------------------------

export const histObjectSetLoad = makeHist(
  "tellus_workshop_object_set_load_seconds",
  "Wall-clock seconds for POST /object-sets/_load forwarded to OSS.",
  ["result"],
);
export const counterObjectSetLoad = makeCounter(
  "tellus_workshop_object_set_load_total",
  "Total count of object-set load calls.",
  ["status"],
);

// ---- B06 — OMS cache -------------------------------------------------------

export const counterOmsCacheHit = makeCounter(
  "tellus_workshop_oms_cache_hit_total",
  "OMS facade cache hits per ontology + kind.",
  ["kind", "result"], // result ∈ {hit, miss}
);
export const histOmsLookup = makeHist(
  "tellus_workshop_oms_lookup_seconds",
  "Wall-clock seconds for OMS facade lookups (B06).",
  ["kind", "result"],
);

// ---- B07 — Filter compiler -------------------------------------------------

export const histFilterCompile = makeHist(
  "tellus_workshop_filter_compile_seconds",
  "Wall-clock seconds for B07 filter compilation (CPU-bound).",
  [],
  // Per spec target P95 ≤ 20ms — sub-ms buckets are useful here.
  [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1],
);

// ---- B08 — Aggregation -----------------------------------------------------

export const histAggregate = makeHist(
  "tellus_workshop_aggregate_seconds",
  "Wall-clock seconds for POST /object-sets/_aggregate.",
  ["result"],
);
export const counterAggregate = makeCounter(
  "tellus_workshop_aggregate_total",
  "Total count of aggregate calls.",
  ["status"],
);
export const counterGroupByKind = makeCounter(
  "tellus_workshop_aggregate_groupby_kind_total",
  "Distribution of selected groupBy kinds per property_type. Used to detect the Bar-XY-numeric-defaults regression.",
  ["kind", "property_type"],
);

// ---- B09 — Action type wizard ---------------------------------------------

export const histActionTypeCreate = makeHist(
  "tellus_workshop_action_type_create_seconds",
  "Wall-clock seconds for POST /action-types (B09).",
  ["result"],
);
export const counterActionTypeCreate = makeCounter(
  "tellus_workshop_action_type_create_total",
  "Total count of action-type creates.",
  ["status"],
);

// ---- B10 — Action validate + apply -----------------------------------------

export const histApply = makeHist(
  "tellus_workshop_apply_seconds",
  "Wall-clock seconds for B10 validate or apply.",
  ["phase", "result"],
);
export const counterApply = makeCounter(
  "tellus_workshop_apply_total",
  "Total count of B10 calls.",
  ["phase", "status"],
);
export const counterStaleObject = makeCounter(
  "tellus_workshop_apply_stale_object_total",
  "Count of apply attempts rejected because the underlying object moved.",
);

// ---------------------------------------------------------------------------
// `instrument` — wraps a 0-arg async function, observing the result label
// histogram and incrementing the result-label counter.
// ---------------------------------------------------------------------------

export async function instrument<T>(
  hist: HistogramHandle,
  counter: CounterHandle | null,
  labels: LabelValues,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    const out = await fn();
    return out;
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    hist.observe({ ...labels, result }, ns / 1e9);
    if (counter) counter.inc({ ...labels, result }, 1);
  }
}
