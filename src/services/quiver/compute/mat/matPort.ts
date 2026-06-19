/**
 * B7 — Materialization port (Polars/Spark/Iceberg).
 *
 * Production wires:
 *  - `polarsExecute` to the in-coordinator-process Polars/DuckDB sidecar
 *    (`tellus-quiver-mat-runner`) over UDS / Arrow Flight (B7 C-12).
 *  - `sparkExecute` to MMDP via Arrow Flight SQL.
 *  - `currentSnapshot` to the Iceberg metadata service.
 *
 * Tests inject `InProcessMatAdapter` for deterministic round-trips.
 *
 * Per G-09: every method receives `branch` and propagates it as
 * `X-Tellus-Branch` on every downstream HTTP / Flight call.
 */

import type { CalcitePlan } from "./calcitePlan";

export interface MatColumnSpec { readonly name: string; readonly type: "STRING" | "NUMBER" | "BOOLEAN" | "DATETIME"; }

export interface MatResult {
  readonly columns: readonly MatColumnSpec[];
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Bytes when serialised to Arrow IPC. The backend uses this to decide
   *  inline vs. blob (B7 C-07). */
  readonly arrowBytes: number;
}

export interface MatExecuteContext {
  readonly branch: string;
  readonly remainingMs: number | undefined;
  readonly userSubject: string;
}

export interface MatPort {
  /**
   * Iceberg snapshot id pinned at the time of read. Returned for every
   * dataset listed by the plan (B7 C-06). Implementation MUST forward
   * `branch` as `X-Tellus-Branch` on its HTTP call (G-09).
   */
  pinSnapshots(plan: CalcitePlan, ctx: MatExecuteContext): Promise<Record<string, string>>;

  /**
   * Polars/DuckDB tier executor (≤ 10 M cells; ≤ 2 GiB memory).
   * Translates the plan to a Polars LazyFrame.
   */
  polarsExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult>;

  /**
   * Spark tier executor (everything else). Submits via Arrow Flight SQL.
   */
  sparkExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult>;

  /**
   * Cardinality estimate for tier selection (B7 C-02 / C-03).
   * Returns `{ rows, cols, estMemoryBytes }` from upstream cache hints.
   */
  estimateCardinality(plan: CalcitePlan, ctx: MatExecuteContext): Promise<{
    readonly rows: number;
    readonly cols: number;
    readonly estMemoryBytes: number;
  }>;
}

export class MatLimitExceededError extends Error {
  readonly errorName = "Tellus:Quiver:TransformTableRowLimit" as const;
  readonly errorCode = "INVALID_ARGUMENT" as const;
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Transform table row limit exceeded: ${actual} > ${limit}`);
  }
}

export class MatUnavailableError extends Error {
  readonly errorName = "Tellus:Quiver:Mat:Unavailable" as const;
  readonly errorCode = "INTERNAL" as const;
  constructor(public readonly tier: "polars" | "spark", public readonly cause?: unknown) {
    super(`Materialization tier ${tier} unavailable`);
  }
}

export class MatTimeoutError extends Error {
  readonly errorName = "Tellus:Quiver:Mat:Timeout" as const;
  readonly errorCode = "DEADLINE_EXCEEDED" as const;
  constructor(public readonly tier: "polars" | "spark", public readonly elapsedMs: number) {
    super(`Materialization timeout in ${tier} tier after ${elapsedMs} ms`);
  }
}
