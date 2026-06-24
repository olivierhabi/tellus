/**
 * B8 — Codex (time-series store) port.
 *
 * Production wires a Conjure-generated Codex client; tests inject the
 * deterministic in-process adapter (D-54). Every call carries `branch`
 * which the implementation MUST forward as `X-Tellus-Branch` (G-09).
 */

export type BucketOp = "avg" | "min" | "max" | "sum" | "last" | "first";

export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq";

export interface SeriesPoint {
  readonly ts: number;        // epoch ms
  readonly value: number;
}

export interface SeriesData {
  readonly seriesRef: string; // canonical id (objectRid|setDef + property + timeRange)
  readonly points: ReadonlyArray<SeriesPoint>;
  /** Number of raw points before display-time bucketing, for SLO budget tests. */
  readonly rawPointCount: number;
}

export interface EventSet {
  readonly seriesRef: string;
  readonly events: ReadonlyArray<{ readonly ts: number; readonly value: number; readonly direction: "above" | "below" }>;
}

export interface TimeRange { readonly fromMs: number; readonly toMs: number; }

export interface CodexCallContext {
  readonly branch: string;
  readonly remainingMs: number | undefined;
}

export interface SeriesQuery {
  readonly objectRid?: string;
  readonly objectSetDefinition?: unknown;
  readonly propertyApiName: string;
  readonly timeRange: TimeRange;
  readonly buckets?: number;     // ≤ 1000
  readonly bucketOp?: BucketOp;
}

export interface CodexPort {
  /**
   * Returns either the resolved SeriesData (warm) or a hydration handle
   * (cold). Tests assert that a fresh query goes cold then resolves
   * within the configured TTL.
   */
  getSeries(q: SeriesQuery, ctx: CodexCallContext): Promise<
    { kind: "warm"; data: SeriesData } | { kind: "cold"; hydrationToken: string }
  >;

  /** Polled by the client for cold queries; returns warm data or "pending"/expired. */
  pollHydration(token: string, ctx: CodexCallContext): Promise<
    { kind: "ready"; data: SeriesData } | { kind: "pending" } | { kind: "expired" }
  >;

  aggregateSeries(
    seriesRefs: readonly SeriesQuery[],
    op: BucketOp,
    windowMs: number,
    ctx: CodexCallContext,
  ): Promise<SeriesData>;

  detectEvents(
    seriesRef: SeriesQuery,
    threshold: number,
    comparator: Comparator,
    ctx: CodexCallContext,
  ): Promise<EventSet>;
}

export class TsHydrationTimeoutError extends Error {
  readonly errorName = "Tellus:Quiver:TsHydrationTimeout" as const;
  readonly errorCode = "DEADLINE_EXCEEDED" as const;
  constructor(public readonly token: string) {
    super(`Hydration timed out for token ${token}`);
  }
}

export class HydrationTokenExpiredError extends Error {
  readonly errorName = "Tellus:Quiver:HydrationTokenExpired" as const;
  readonly errorCode = "FAILED_PRECONDITION" as const;
  constructor(public readonly token: string) {
    super(`Hydration token ${token} has expired (TTL 60 s)`);
  }
}

export class HydrationTokenUnknownError extends Error {
  readonly errorName = "Tellus:Quiver:HydrationTokenUnknown" as const;
  readonly errorCode = "NOT_FOUND" as const;
  constructor(public readonly token: string) {
    super(`Hydration token ${token} not found`);
  }
}
