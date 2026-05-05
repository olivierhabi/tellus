/**
 * B8 — In-process Codex adapter for tests + Phase-4 development.
 *
 * Per D-54: until the real Codex Conjure client lands, this adapter
 * synthesises deterministic series from a registered raw-points map.
 * The first call for a given (seriesRef, timeRange) returns "cold" and
 * the second call resolves the hydration token to "ready". Subsequent
 * calls for the same (seriesRef, timeRange) return "warm" directly.
 *
 * Hydration token TTL = 60 s (B8 C-09). Tests inject `now()` for
 * deterministic time control.
 */

import {
  HydrationTokenExpiredError,
  HydrationTokenUnknownError,
  type CodexCallContext,
  type CodexPort,
  type EventSet,
  type SeriesData,
  type SeriesPoint,
  type SeriesQuery,
} from "./codexPort";
import { bucketSeries } from "./bucketing";

export const HYDRATION_TOKEN_TTL_MS = 60_000;

interface RawSeries {
  readonly points: ReadonlyArray<SeriesPoint>;
}

interface PendingHydration {
  readonly seriesRef: string;
  readonly query: SeriesQuery;
  readonly createdAtMs: number;
  resolved: boolean;
}

export class InProcessCodexAdapter implements CodexPort {
  private readonly raw = new Map<string, RawSeries>(); // key: `${seriesKey}|${propertyApiName}`
  private readonly hydrationStarted = new Set<string>();
  private readonly tokens = new Map<string, PendingHydration>();
  readonly calls: Array<{ op: string; branch: string; remainingMs: number | undefined }> = [];

  constructor(private readonly nowFn: () => number = () => Date.now()) {}

  registerSeries(opts: {
    objectRid?: string;
    objectSetDefinition?: unknown;
    propertyApiName: string;
    points: ReadonlyArray<SeriesPoint>;
  }): void {
    const sub = opts.objectRid ?? JSON.stringify(opts.objectSetDefinition ?? {});
    this.raw.set(`${sub}|${opts.propertyApiName}`, { points: opts.points });
  }

  // -------- CodexPort --------------------------------------------------

  async getSeries(q: SeriesQuery, ctx: CodexCallContext) {
    this.calls.push({ op: "getSeries", branch: ctx.branch, remainingMs: ctx.remainingMs });
    const ref = this.canonicalRef(q);
    if (!this.hydrationStarted.has(ref)) {
      this.hydrationStarted.add(ref);
      const token = `hyd-${ref}-${this.nowFn().toString(36)}`;
      this.tokens.set(token, { seriesRef: ref, query: q, createdAtMs: this.nowFn(), resolved: false });
      return { kind: "cold" as const, hydrationToken: token };
    }
    return { kind: "warm" as const, data: this.materialise(q) };
  }

  async pollHydration(token: string, ctx: CodexCallContext) {
    this.calls.push({ op: "pollHydration", branch: ctx.branch, remainingMs: ctx.remainingMs });
    const handle = this.tokens.get(token);
    if (!handle) throw new HydrationTokenUnknownError(token);
    const ageMs = this.nowFn() - handle.createdAtMs;
    if (ageMs > HYDRATION_TOKEN_TTL_MS) {
      this.tokens.delete(token);
      throw new HydrationTokenExpiredError(token);
    }
    if (!handle.resolved) {
      handle.resolved = true;
      return { kind: "ready" as const, data: this.materialise(handle.query) };
    }
    return { kind: "ready" as const, data: this.materialise(handle.query) };
  }

  async aggregateSeries(refs: readonly SeriesQuery[], op: import("./codexPort").BucketOp, windowMs: number, ctx: CodexCallContext): Promise<SeriesData> {
    this.calls.push({ op: "aggregateSeries", branch: ctx.branch, remainingMs: ctx.remainingMs });
    if (refs.length === 0) {
      return { seriesRef: "agg|empty", points: [], rawPointCount: 0 };
    }
    const merged: SeriesPoint[] = [];
    for (const r of refs) merged.push(...this.materialiseRaw(r));
    merged.sort((a, b) => a.ts - b.ts);
    const lastTs = merged[merged.length - 1].ts;
    const buckets = Math.min(1000, Math.max(1, Math.floor((lastTs - merged[0].ts) / Math.max(1, windowMs))));
    return {
      seriesRef: `agg|${refs.map((r) => this.canonicalRef(r)).join(",")}|${op}|${windowMs}`,
      points: bucketSeries(merged, buckets, op),
      rawPointCount: merged.length,
    };
  }

  async detectEvents(q: SeriesQuery, threshold: number, comparator: import("./codexPort").Comparator, ctx: CodexCallContext): Promise<EventSet> {
    this.calls.push({ op: "detectEvents", branch: ctx.branch, remainingMs: ctx.remainingMs });
    const raw = this.materialiseRaw(q);
    const events = raw
      .filter((p) => compare(p.value, threshold, comparator))
      .map((p) => ({
        ts: p.ts,
        value: p.value,
        direction: comparator === "lt" || comparator === "lte" ? ("below" as const) : ("above" as const),
      }));
    return { seriesRef: this.canonicalRef(q), events };
  }

  // -------- helpers ----------------------------------------------------

  private canonicalRef(q: SeriesQuery): string {
    const sub = q.objectRid ?? JSON.stringify(q.objectSetDefinition ?? {});
    const tr = `${q.timeRange.fromMs}-${q.timeRange.toMs}`;
    return `${sub}|${q.propertyApiName}|${tr}`;
  }

  private rawKey(q: SeriesQuery, prop: string): string {
    const sub = q.objectRid ?? JSON.stringify(q.objectSetDefinition ?? {});
    return `${sub}|${prop}`;
  }

  private materialiseRaw(q: SeriesQuery): SeriesPoint[] {
    const r = this.raw.get(this.rawKey(q, q.propertyApiName));
    if (!r) throw new Error(`Unknown series: ${this.rawKey(q, q.propertyApiName)}`);
    const { fromMs, toMs } = q.timeRange;
    return r.points.filter((p) => p.ts >= fromMs && p.ts <= toMs);
  }

  private materialise(q: SeriesQuery): SeriesData {
    const raw = this.materialiseRaw(q);
    const buckets = q.buckets ?? 1000;
    const op = q.bucketOp ?? "avg";
    return {
      seriesRef: this.canonicalRef(q),
      points: bucketSeries(raw, buckets, op),
      rawPointCount: raw.length,
    };
  }
}

function compare(a: number, b: number, op: import("./codexPort").Comparator): boolean {
  switch (op) {
    case "gt":  return a > b;
    case "gte": return a >= b;
    case "lt":  return a < b;
    case "lte": return a <= b;
    case "eq":  return a === b;
  }
}
