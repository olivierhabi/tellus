// =============================================================================
// Workshop OSS Adapter — D-02 boundary
//
// Workshop talks to "OSS" (object set service) through this adapter. In the
// monolith deploy (D-02) the adapter calls in-process services. In tests it
// is a recording fake that captures the outbound request — per spec §B05
// acceptance: "with a recording test double in front of OSS that captures
// the outbound request".
//
// Branch + JWT propagation (§0.5, §0.6) is enforced by the adapter contract:
// every method takes an OssRequestContext, and the adapter MUST forward
// `branchRid` and `jwt` verbatim to the underlying service. Tests assert
// this by inspecting the recorded request.
// =============================================================================

import type { Predicate } from "./filterCompiler.js";

export interface OssRequestContext {
  /** Multipass JWT — forwarded verbatim downstream (§0.6). */
  jwt: string;
  /** Branch RID — forwarded verbatim downstream (§0.5). null = main. */
  branchRid: string | null;
  /** Stable user RID for audit + idempotency keying. */
  userRid: string;
}

export interface OssLoadRequest {
  ontologyRid: string;
  objectTypeApiName: string;
  predicate: Predicate;
  pageSize: number; // 1..1000 per B05 SLO; >1000 downgrades
  pageToken?: string | null;
  orderBy?: ReadonlyArray<{ field: string; direction: "asc" | "desc" }>;
  /** spec §B05: forwarded verbatim */
  executionMode?: "PREFER_ACCURACY" | "PREFER_SPEED" | null;
  snapshotConsistency?: "EVENTUAL" | "STRONG" | null;
}

export interface OssLoadResponse {
  objects: ReadonlyArray<Record<string, unknown>>;
  nextPageToken: string | null;
  totalEstimate: number | null;
}

export interface OssAggregationDef {
  name: string;
  property: string;
  groupBy?:
    | { kind: "exact" }
    | { kind: "fixedWidthBuckets"; width: number; minBuckets?: number }
    | { kind: "dateRangeBuckets"; ranges: ReadonlyArray<{ from?: string; to?: string }> }
    | { kind: "topN"; n: number };
  aggregation:
    | { kind: "count" }
    | { kind: "sum"; on: string }
    | { kind: "avg"; on: string }
    | { kind: "min"; on: string }
    | { kind: "max"; on: string }
    | { kind: "approxDistinct"; on: string };
}

export interface OssAggregateRequest {
  ontologyRid: string;
  objectTypeApiName: string;
  predicate: Predicate;
  aggregations: ReadonlyArray<OssAggregationDef>;
  executionMode?: "PREFER_ACCURACY" | "PREFER_SPEED" | null;
}

export interface OssAggregateResponse {
  buckets: ReadonlyArray<{
    name: string;
    groups: ReadonlyArray<{ key: unknown; values: Record<string, number | null> }>;
  }>;
}

/** The contract Workshop holds against OSS. Real prod and tests both implement it. */
export interface WorkshopOssAdapter {
  load(req: OssLoadRequest, ctx: OssRequestContext): Promise<OssLoadResponse>;
  aggregate(
    req: OssAggregateRequest,
    ctx: OssRequestContext,
  ): Promise<OssAggregateResponse>;
}

// ---------------------------------------------------------------------------
// Recording fake — for tests + as a sane default in dev when OS is absent
// ---------------------------------------------------------------------------

export interface RecordedOssCall {
  kind: "load" | "aggregate";
  request: OssLoadRequest | OssAggregateRequest;
  context: OssRequestContext;
  at: number;
}

export class RecordingOssAdapter implements WorkshopOssAdapter {
  readonly calls: RecordedOssCall[] = [];

  constructor(
    private readonly nextLoad: (
      r: OssLoadRequest,
      c: OssRequestContext,
    ) => OssLoadResponse | Promise<OssLoadResponse> = () => ({
      objects: [],
      nextPageToken: null,
      totalEstimate: 0,
    }),
    private readonly nextAggregate: (
      r: OssAggregateRequest,
      c: OssRequestContext,
    ) => OssAggregateResponse | Promise<OssAggregateResponse> = () => ({
      buckets: [],
    }),
  ) {}

  async load(req: OssLoadRequest, ctx: OssRequestContext): Promise<OssLoadResponse> {
    this.calls.push({ kind: "load", request: req, context: ctx, at: Date.now() });
    return this.nextLoad(req, ctx);
  }
  async aggregate(
    req: OssAggregateRequest,
    ctx: OssRequestContext,
  ): Promise<OssAggregateResponse> {
    this.calls.push({
      kind: "aggregate",
      request: req,
      context: ctx,
      at: Date.now(),
    });
    return this.nextAggregate(req, ctx);
  }

  reset(): void {
    this.calls.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton adapter — service code reads from this. Tests swap via setOss().
// ---------------------------------------------------------------------------

let _adapter: WorkshopOssAdapter = new RecordingOssAdapter();

export function getOss(): WorkshopOssAdapter {
  return _adapter;
}

export function setOss(adapter: WorkshopOssAdapter): WorkshopOssAdapter {
  const prev = _adapter;
  _adapter = adapter;
  return prev;
}
