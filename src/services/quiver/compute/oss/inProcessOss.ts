/**
 * B6 — In-process OSS adapter.
 *
 * Per D-30: until a Conjure-generated OSS client lands, this adapter
 * supplies deterministic in-memory behavior so B6 ships testable and
 * unblocks downstream tasks (B7, B8, B9, F3..F10). It records every
 * call so tests can assert branch propagation, deadline forwarding,
 * and limit enforcement (B6 C-09).
 *
 * Production replaces this via `setOssPortForTests()` (or the equivalent
 * production wiring in `compute/context.ts`) once the Conjure client
 * lands.
 */

import {
  ActionApplyForbiddenError,
  OssLimitExceededError,
  type AggregationMode,
  type AggregationSpec,
  type ColumnSpec,
  type ObjectSetDefinition,
  type OssCallContext,
  type OssPort,
  type TransformTable,
} from "./ossPort";

export interface InProcessOssAdapterOptions {
  /** Force every estimateCardinality to return this size (test injection for limit tests). */
  forcedCardinality?: number;
  /** Force the storage generation. */
  forcedStorageGeneration?: "OSv1" | "OSv2";
  /** Set of action API names the user is permitted to apply. */
  permittedActions?: ReadonlySet<string>;
  /** Inject a synthetic delay (ms) on every call. */
  syntheticDelayMs?: number;
  /** Throw on every call (for circuit/unavailable tests). */
  throwError?: Error;
}

export interface CallRecord {
  method: string;
  args: unknown[];
  branch: string;
  remainingMs: number;
  userSubject?: string;
  at: number;
}

const OSV1_INPUT_LIMIT = 100_000;
const RESULT_LIMIT_OSV2 = 10_000_000;
const SEARCH_AROUND_DEPTH_LIMIT = 3;

export class InProcessOssAdapter implements OssPort {
  readonly calls: CallRecord[] = [];
  constructor(private readonly opts: InProcessOssAdapterOptions = {}) {}

  private async tick<T>(method: string, args: unknown[], ctx: OssCallContext, fn: () => T | Promise<T>): Promise<T> {
    this.calls.push({
      method,
      args,
      branch: ctx.branch,
      remainingMs: ctx.remainingMs,
      userSubject: ctx.userSubject,
      at: Date.now(),
    });
    if (this.opts.throwError) throw this.opts.throwError;
    if (this.opts.syntheticDelayMs) {
      await new Promise((r) => setTimeout(r, this.opts.syntheticDelayMs));
    }
    return fn();
  }

  /** Compute the implied search-around depth from a definition. */
  private depthOf(d: ObjectSetDefinition): number {
    let depth = 0;
    let cur: ObjectSetDefinition | undefined = d;
    while (cur) {
      if (cur.kind === "searchAround") {
        depth++;
        cur = cur.src;
      } else if (cur.kind === "filter") {
        cur = cur.src;
      } else {
        break;
      }
    }
    return depth;
  }

  async createTemporaryObjectSet(definition: ObjectSetDefinition, ctx: OssCallContext): Promise<string> {
    return this.tick("createTemporaryObjectSet", [definition], ctx, () => {
      const id = `tmp-${Math.random().toString(36).slice(2, 12)}`;
      return id;
    });
  }

  async loadObjectSetPage(
    definition: ObjectSetDefinition,
    pageToken: string | null,
    pageSize: number,
    ctx: OssCallContext,
  ) {
    return this.tick("loadObjectSetPage", [definition, pageToken, pageSize], ctx, () => {
      const storageGeneration = this.opts.forcedStorageGeneration ?? "OSv2";
      const totalRows = this.opts.forcedCardinality ?? Math.min(pageSize, 1000);
      if (storageGeneration === "OSv1" && totalRows > OSV1_INPUT_LIMIT) {
        throw new OssLimitExceededError("osv1_input", OSV1_INPUT_LIMIT, totalRows);
      }
      const columns: ColumnSpec[] = [
        { name: "id", type: "STRING" },
        { name: "value", type: "NUMBER" },
      ];
      const rows = Array.from({ length: Math.min(totalRows, pageSize) }, (_, i) => [`obj-${i}`, i]);
      const table: TransformTable = { columns, rows };
      return { table, nextPageToken: null, totalRows, storageGeneration };
    });
  }

  async estimateCardinality(definition: ObjectSetDefinition, ctx: OssCallContext) {
    return this.tick("estimateCardinality", [definition], ctx, () => ({
      rows: this.opts.forcedCardinality ?? 100,
      storageGeneration: this.opts.forcedStorageGeneration ?? "OSv2",
    }));
  }

  async aggregateObjectSet(
    definition: ObjectSetDefinition,
    groupBy: ReadonlyArray<string>,
    aggregations: ReadonlyArray<AggregationSpec>,
    mode: AggregationMode,
    ctx: OssCallContext,
  ): Promise<TransformTable> {
    return this.tick("aggregateObjectSet", [definition, groupBy, aggregations, mode], ctx, () => {
      const cardinality = this.opts.forcedCardinality ?? 100;
      const storage = this.opts.forcedStorageGeneration ?? "OSv2";
      if (storage === "OSv1" && cardinality > OSV1_INPUT_LIMIT) {
        throw new OssLimitExceededError("osv1_input", OSV1_INPUT_LIMIT, cardinality);
      }
      const columns: ColumnSpec[] = [
        ...groupBy.map<ColumnSpec>((g) => ({ name: g, type: "STRING" })),
        ...aggregations.map<ColumnSpec>((a) => ({ name: a.alias, type: "NUMBER" })),
      ];
      const groupCells: unknown[] = groupBy.map(() => "g0");
      const aggCells: unknown[] = aggregations.map(() => 1);
      const rows: unknown[][] = [[...groupCells, ...aggCells]];
      return { columns, rows };
    });
  }

  async searchAround(
    definition: ObjectSetDefinition,
    linkApiName: string,
    ctx: OssCallContext,
  ) {
    return this.tick("searchAround", [definition, linkApiName], ctx, () => {
      const baseDepth = this.depthOf(definition);
      const newDepth = baseDepth + 1;
      if (newDepth > SEARCH_AROUND_DEPTH_LIMIT) {
        throw new OssLimitExceededError("search_around_depth", SEARCH_AROUND_DEPTH_LIMIT, undefined, newDepth);
      }
      const storage = this.opts.forcedStorageGeneration ?? "OSv2";
      const estimatedRows = this.opts.forcedCardinality ?? 1_000;
      if (storage === "OSv2" && estimatedRows > RESULT_LIMIT_OSV2) {
        throw new OssLimitExceededError("osv2_result", RESULT_LIMIT_OSV2, estimatedRows);
      }
      return {
        definition: { kind: "searchAround" as const, src: definition, linkApiName },
        estimatedRows,
        storageGeneration: storage,
      };
    });
  }

  async canApplyAction(actionApiName: string, ctx: OssCallContext): Promise<boolean> {
    return this.tick("canApplyAction", [actionApiName], ctx, () => {
      const set = this.opts.permittedActions;
      if (!set) return true; // permissive by default in-process
      return set.has(actionApiName);
    });
  }

  async applyAction(
    actionApiName: string,
    paramBindings: Record<string, unknown>,
    ifMatch: string | null,
    ctx: OssCallContext,
  ) {
    return this.tick("applyAction", [actionApiName, paramBindings, ifMatch], ctx, () => {
      if (!ctx.userSubject) {
        throw new ActionApplyForbiddenError(actionApiName, "anonymous");
      }
      const set = this.opts.permittedActions;
      if (set && !set.has(actionApiName)) {
        throw new ActionApplyForbiddenError(actionApiName, ctx.userSubject);
      }
      return { outcome: "success" as const, appliedAt: new Date().toISOString() };
    });
  }

  async distinctPropertyValues(
    definition: ObjectSetDefinition,
    property: string,
    topN: number,
    ctx: OssCallContext,
  ) {
    return this.tick("distinctPropertyValues", [definition, property, topN], ctx, () => {
      const cap = Math.min(topN, 100); // hard cap so leaks/PII risks bounded
      const values = Array.from({ length: cap }, (_, i) => `${property}-v${i}`);
      return { values, truncated: cap < topN };
    });
  }
}
