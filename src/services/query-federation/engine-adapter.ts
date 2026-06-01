// ---------------------------------------------------------------------------
// B8 — FederationEngineAdapter (spec §B8 line 403).
//
// Pluggable interface. Default: node-sql-builder (kysely + pg + arrow).
// Prod swap: calcite-flight (Calcite + Arrow Flight SQL).
//
// A federation call accepts a typed query plan + connection RID, returns
// an Arrow IPC stream (Buffer chunks) over a Readable.
// ---------------------------------------------------------------------------

import type { Readable } from "node:stream";

export type FilterOp =
  | "="
  | "<"
  | ">"
  | "<="
  | ">="
  | "<>"
  | "IS NULL"
  | "IS NOT NULL"
  | "IN"
  | "BETWEEN"
  | "LIKE"
  | "ILIKE"
  | "~";

export interface FilterNode {
  kind: "filter";
  op: FilterOp;
  column: string;
  /** RHS literal(s). For BETWEEN: [lo, hi]; for IN: array. */
  value?: unknown;
  /** Logical composition. */
  not?: boolean;
}

export interface AndNode {
  kind: "and";
  children: PredicateNode[];
}
export interface OrNode {
  kind: "or";
  children: PredicateNode[];
}
export type PredicateNode = FilterNode | AndNode | OrNode;

export interface QueryPlan {
  virtualTableRid: string;
  /** Projection — columns to return. Empty = SELECT *. */
  project: string[];
  /** Optional WHERE tree. */
  where?: PredicateNode;
  /** Optional aggregate. */
  aggregate?: {
    fn: "COUNT" | "SUM" | "MIN" | "MAX" | "AVG";
    column?: string;
    groupBy?: string[];
  };
  /** Optional limit + offset. */
  limit?: number;
  offset?: number;
  /** Optional order by. */
  orderBy?: Array<{ column: string; direction: "ASC" | "DESC" }>;
}

export interface ExecutionResult {
  /** Arrow IPC stream (application/vnd.apache.arrow.stream). */
  stream: Readable;
  /** What was pushed down to source vs local. */
  pushdownPlan: PushdownPlan;
}

export interface PushdownPlan {
  pushed: {
    filters: FilterNode[];
    project: string[];
    aggregate?: QueryPlan["aggregate"];
    limit?: number;
    sort?: QueryPlan["orderBy"];
  };
  local: {
    filters: FilterNode[];
    /** True if the engine had to materialize the full source before applying local ops. */
    materialized: boolean;
  };
}

export interface FederationEngineAdapter {
  execute(plan: QueryPlan): Promise<ExecutionResult>;
  explain(plan: QueryPlan): Promise<PushdownPlan>;
}

export async function loadFederationAdapter(): Promise<FederationEngineAdapter> {
  const which = process.env.TELLUS_FEDERATION_ADAPTER ?? "node-sql-builder";
  switch (which) {
    case "node-sql-builder": {
      const mod = await import("./adapters/node-sql-builder");
      return mod.createNodeSqlBuilderAdapter();
    }
    case "calcite-flight": {
      const mod = await import("./adapters/calcite-flight");
      return mod.createCalciteFlightAdapter();
    }
    default:
      throw new Error(`Unknown TELLUS_FEDERATION_ADAPTER: ${which}`);
  }
}
