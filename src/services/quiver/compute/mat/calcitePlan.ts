/**
 * B7 — Calcite logical plan synthesis.
 *
 * Per spec §B7 C-04: every materialization is compiled to a Calcite logical
 * plan (serializable to JSON) that is identical between Polars and Spark
 * tiers. The real coordinator embeds Apache Calcite via a JNI bridge; the
 * in-process implementation here mirrors the relational-algebra shape so
 * the plan-equivalence golden test (B7 C-05) can compare against either
 * tier output byte-for-byte.
 *
 * The plan is a discriminated union of relational nodes. Inputs to a node
 * are referenced by `id`; the root is the materialization output. Plans
 * are normalised by `canonicalisePlan` before hashing so logically-
 * equivalent plans compare equal.
 */

export interface ColumnRef { readonly source: string; readonly column: string; }

export interface ScanNode {
  readonly kind: "scan";
  readonly id: string;
  readonly datasetRid: string;        // Iceberg dataset RID (for snapshot pinning, B7 C-06)
  readonly columns: readonly string[];
}

export interface ProjectNode {
  readonly kind: "project";
  readonly id: string;
  readonly input: string;
  readonly columns: readonly string[];
}

export interface FilterNode {
  readonly kind: "filter";
  readonly id: string;
  readonly input: string;
  readonly predicate: { readonly op: string; readonly args: readonly unknown[] };
}

export interface JoinNode {
  readonly kind: "join";
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly on: ReadonlyArray<{ readonly leftCol: string; readonly rightCol: string }>;
  readonly type: "inner" | "left" | "right" | "outer";
}

export interface AggregateNode {
  readonly kind: "aggregate";
  readonly id: string;
  readonly input: string;
  readonly groupBy: readonly string[];
  readonly aggregations: ReadonlyArray<{ readonly fn: "sum" | "count" | "avg" | "min" | "max"; readonly column?: string; readonly alias: string }>;
}

export interface PivotNode {
  readonly kind: "pivot";
  readonly id: string;
  readonly input: string;
  readonly rows: readonly string[];
  readonly cols: string;
  readonly value: string;
  readonly fn: "sum" | "count" | "avg" | "min" | "max";
}

export interface ExpressionNode {
  readonly kind: "expression";
  readonly id: string;
  readonly input: string;
  readonly column: string;
  readonly expression: string;        // SQL-ish; opaque to the planner
}

export interface OrderByNode {
  readonly kind: "orderBy";
  readonly id: string;
  readonly input: string;
  readonly orderings: ReadonlyArray<{ readonly column: string; readonly direction: "asc" | "desc" }>;
}

export type CalciteNode =
  | ScanNode | ProjectNode | FilterNode | JoinNode
  | AggregateNode | PivotNode | ExpressionNode | OrderByNode;

export interface CalcitePlan {
  readonly root: string;
  readonly nodes: ReadonlyArray<CalciteNode>;
}

/**
 * Sort the `nodes` array by `id` so two plans that differ only in node order
 * compare equal. Plans with different `root` ids do NOT compare equal —
 * the root identity is part of the plan's semantics.
 */
export function canonicalisePlan(plan: CalcitePlan): CalcitePlan {
  const sorted = [...plan.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { root: plan.root, nodes: sorted };
}

/**
 * Returns true iff the two plans normalise to the same JSON.
 * Used by the plan-equivalence golden test (B7 C-05).
 */
export function plansEqual(a: CalcitePlan, b: CalcitePlan): boolean {
  return JSON.stringify(canonicalisePlan(a)) === JSON.stringify(canonicalisePlan(b));
}

/**
 * Walk the plan and return the set of `datasetRid` strings referenced by any
 * `scan` node — the source of truth for Iceberg snapshot pinning (B7 C-06).
 */
export function datasetsOf(plan: CalcitePlan): readonly string[] {
  const out = new Set<string>();
  for (const n of plan.nodes) if (n.kind === "scan") out.add(n.datasetRid);
  return [...out].sort();
}
