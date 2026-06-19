/**
 * B6 — Object Set Service (OSS) port.
 *
 * The contract Quiver depends on. Production wires a real Conjure-generated
 * OSS client; tests inject deterministic in-memory adapters. Every method
 * carries a `branch` argument that the implementation MUST send as the
 * `X-Tellus-Branch` header on the underlying HTTP call (G-09).
 *
 * Per D-30: until a Conjure-generated client lands, the in-repo
 * `InProcessOssAdapter` (see ./inProcessOss.ts) supplies deterministic
 * behavior so the B5 → B6 dispatch path can be exercised end-to-end.
 */

export interface ColumnSpec {
  name: string;
  type: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME";
}

export interface TransformTable {
  columns: ColumnSpec[];
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
}

export type ObjectSetDefinition =
  | { kind: "named"; ontologyRid: string; objectSetRid: string }
  | { kind: "filter"; src: ObjectSetDefinition; predicate: unknown }
  | { kind: "searchAround"; src: ObjectSetDefinition; linkApiName: string }
  | { kind: "temporary"; rid: string };

export type AggregationMode = "PREFER_SPEED" | "PREFER_ACCURACY";

export interface AggregationSpec {
  /** Output column name. */
  alias: string;
  /** Source property. */
  property: string;
  /** Operation. */
  op: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
}

export interface OssCallContext {
  branch: string;
  /** Remaining deadline budget in ms — for the underlying HTTP timeout. */
  remainingMs: number;
  /** Optional user JWT subject for OMS canApplyAction checks. */
  userSubject?: string;
}

export class OssLimitExceededError extends Error {
  readonly code = "OBJECT_SET_LIMIT_EXCEEDED";
  constructor(public readonly kind: string, public readonly limit: number, public readonly observed?: number, public readonly depth?: number) {
    super(`object set limit exceeded: kind=${kind} limit=${limit}${observed !== undefined ? ` observed=${observed}` : ""}`);
    this.name = "OssLimitExceededError";
  }
}

export class OssUnavailableError extends Error {
  readonly code = "OSS_UNAVAILABLE";
  constructor(message = "OSS unavailable after retries") {
    super(message);
    this.name = "OssUnavailableError";
  }
}

export class OssQueryTimeoutError extends Error {
  readonly code = "OSS_QUERY_TIMEOUT";
  constructor(message = "OSS query timed out") {
    super(message);
    this.name = "OssQueryTimeoutError";
  }
}

export class ActionApplyForbiddenError extends Error {
  readonly code = "ACTION_APPLY_FORBIDDEN";
  constructor(public readonly actionApiName: string, public readonly userSubject: string) {
    super(`user ${userSubject} not authorized to apply action ${actionApiName}`);
    this.name = "ActionApplyForbiddenError";
  }
}

export interface OssPort {
  /**
   * Create a 24h-TTL temporary object set on the named storage.
   * Returns a temporary rid usable as `{kind: "temporary", rid}`.
   */
  createTemporaryObjectSet(definition: ObjectSetDefinition, ctx: OssCallContext): Promise<string>;

  /**
   * Load a paged subset of the object set. Returns a TransformTable
   * (so OBJECT_SET cards can output a renderable shape downstream).
   */
  loadObjectSetPage(
    definition: ObjectSetDefinition,
    pageToken: string | null,
    pageSize: number,
    ctx: OssCallContext,
  ): Promise<{ table: TransformTable; nextPageToken: string | null; totalRows: number; storageGeneration: "OSv1" | "OSv2" }>;

  /** Cardinality estimate without materializing the result. */
  estimateCardinality(definition: ObjectSetDefinition, ctx: OssCallContext): Promise<{ rows: number; storageGeneration: "OSv1" | "OSv2" }>;

  aggregateObjectSet(
    definition: ObjectSetDefinition,
    groupBy: ReadonlyArray<string>,
    aggregations: ReadonlyArray<AggregationSpec>,
    mode: AggregationMode,
    ctx: OssCallContext,
  ): Promise<TransformTable>;

  searchAround(
    definition: ObjectSetDefinition,
    linkApiName: string,
    ctx: OssCallContext,
  ): Promise<{ definition: ObjectSetDefinition; estimatedRows: number; storageGeneration: "OSv1" | "OSv2" }>;

  /** OMS canApplyAction permission gate (B6 C-08). */
  canApplyAction(actionApiName: string, ctx: OssCallContext): Promise<boolean>;

  applyAction(
    actionApiName: string,
    paramBindings: Record<string, unknown>,
    ifMatch: string | null,
    ctx: OssCallContext,
  ): Promise<{ outcome: "success" | "failure"; appliedAt: string }>;

  /** Distinct property values capped at `topN` (B6 PROPERTY_VALUE_SELECT). */
  distinctPropertyValues(
    definition: ObjectSetDefinition,
    property: string,
    topN: number,
    ctx: OssCallContext,
  ): Promise<{ values: unknown[]; truncated: boolean }>;
}
