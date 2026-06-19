/**
 * B7 — In-process MatAdapter for tests + Phase-4 development.
 *
 * Per D-50: until the real Polars sidecar + MMDP Spark Flight bridge
 * are wired, this adapter executes the Calcite plan against an in-memory
 * dataset registry. Both `polarsExecute` and `sparkExecute` evaluate the
 * **same** canonicalised plan against the **same** in-memory rows, so
 * the plan-equivalence golden test (B7 C-05) can compare byte-for-byte
 * Arrow IPC outputs.
 *
 * The adapter records the per-call branch + remainingMs so the branch-
 * propagation tests (B7 C-10, G-09) can assert.
 */

import {
  MatLimitExceededError,
  type MatExecuteContext,
  type MatPort,
  type MatResult,
  type MatColumnSpec,
} from "./matPort";
import {
  datasetsOf,
  type CalcitePlan,
  type CalciteNode,
  type AggregateNode,
  type FilterNode,
  type JoinNode,
  type OrderByNode,
  type PivotNode,
  type ProjectNode,
  type ExpressionNode,
} from "./calcitePlan";

interface RegisteredDataset {
  readonly columns: readonly MatColumnSpec[];
  readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
  /** Iceberg snapshot id pinned for tests. */
  readonly snapshotId: string;
}

const TRANSFORM_TABLE_ROW_LIMIT = 50_000;

export class InProcessMatAdapter implements MatPort {
  private readonly datasets = new Map<string, RegisteredDataset>();
  readonly calls: Array<{ op: string; branch: string; remainingMs: number | undefined }> = [];

  registerDataset(rid: string, dataset: RegisteredDataset): void {
    this.datasets.set(rid, dataset);
  }

  // -------- MatPort -----------------------------------------------------

  async pinSnapshots(plan: CalcitePlan, ctx: MatExecuteContext): Promise<Record<string, string>> {
    this.calls.push({ op: "pinSnapshots", branch: ctx.branch, remainingMs: ctx.remainingMs });
    const out: Record<string, string> = {};
    for (const rid of datasetsOf(plan)) {
      const ds = this.datasets.get(rid);
      if (!ds) throw new Error(`Unknown dataset: ${rid}`);
      out[rid] = ds.snapshotId;
    }
    return out;
  }

  async estimateCardinality(plan: CalcitePlan, ctx: MatExecuteContext): Promise<{ rows: number; cols: number; estMemoryBytes: number }> {
    this.calls.push({ op: "estimateCardinality", branch: ctx.branch, remainingMs: ctx.remainingMs });
    let rows = 0;
    let cols = 0;
    for (const rid of datasetsOf(plan)) {
      const ds = this.datasets.get(rid);
      if (!ds) continue;
      rows += ds.rows.length;
      cols = Math.max(cols, ds.columns.length);
    }
    return { rows, cols, estMemoryBytes: rows * cols * 8 };
  }

  async polarsExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult> {
    this.calls.push({ op: "polarsExecute", branch: ctx.branch, remainingMs: ctx.remainingMs });
    return this.runPlan(plan);
  }

  async sparkExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult> {
    this.calls.push({ op: "sparkExecute", branch: ctx.branch, remainingMs: ctx.remainingMs });
    return this.runPlan(plan);
  }

  // -------- internal evaluator -----------------------------------------

  private runPlan(plan: CalcitePlan): MatResult {
    const byId = new Map<string, CalciteNode>();
    for (const n of plan.nodes) byId.set(n.id, n);
    const evalNode = (id: string): MatResult => {
      const node = byId.get(id);
      if (!node) throw new Error(`Unknown node id: ${id}`);
      switch (node.kind) {
        case "scan":       return this.evalScan(node);
        case "project":    return this.evalProject(node, evalNode);
        case "filter":     return this.evalFilter(node, evalNode);
        case "join":       return this.evalJoin(node, evalNode);
        case "aggregate":  return this.evalAggregate(node, evalNode);
        case "pivot":      return this.evalPivot(node, evalNode);
        case "expression": return this.evalExpression(node, evalNode);
        case "orderBy":    return this.evalOrderBy(node, evalNode);
      }
    };
    const result = evalNode(plan.root);
    if (result.rows.length > TRANSFORM_TABLE_ROW_LIMIT) {
      throw new MatLimitExceededError(TRANSFORM_TABLE_ROW_LIMIT, result.rows.length);
    }
    return finalise(result);
  }

  private evalScan(n: { datasetRid: string; columns: readonly string[] }): MatResult {
    const ds = this.datasets.get(n.datasetRid);
    if (!ds) throw new Error(`Unknown dataset: ${n.datasetRid}`);
    const indices = n.columns.map((c) => ds.columns.findIndex((col) => col.name === c));
    if (indices.some((i) => i < 0)) throw new Error(`Column not found in ${n.datasetRid}: ${n.columns.join(",")}`);
    const columns = indices.map((i) => ds.columns[i]);
    const rows = ds.rows.map((row) => indices.map((i) => row[i]));
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalProject(n: ProjectNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const idx = n.columns.map((c) => inp.columns.findIndex((col) => col.name === c));
    if (idx.some((i) => i < 0)) throw new Error(`Project column missing: ${n.columns.join(",")}`);
    const columns = idx.map((i) => inp.columns[i]);
    const rows = inp.rows.map((r) => idx.map((i) => r[i]));
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalFilter(n: FilterNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const colIdx = (col: string): number => {
      const i = inp.columns.findIndex((c) => c.name === col);
      if (i < 0) throw new Error(`Filter column missing: ${col}`);
      return i;
    };
    const rows = inp.rows.filter((r) => evalPredicate(n.predicate, r, colIdx));
    return { columns: inp.columns, rows, arrowBytes: estArrow(inp.columns, rows) };
  }

  private evalJoin(n: JoinNode, ev: (id: string) => MatResult): MatResult {
    const left = ev(n.left);
    const right = ev(n.right);
    const lIdx = n.on.map((o) => left.columns.findIndex((c) => c.name === o.leftCol));
    const rIdx = n.on.map((o) => right.columns.findIndex((c) => c.name === o.rightCol));
    if (lIdx.some((i) => i < 0) || rIdx.some((i) => i < 0)) {
      throw new Error(`Join column not found`);
    }
    const columns = [...left.columns, ...right.columns];
    const rows: unknown[][] = [];
    for (const lr of left.rows) {
      for (const rr of right.rows) {
        let matched = true;
        for (let k = 0; k < n.on.length; k++) {
          if (lr[lIdx[k]] !== rr[rIdx[k]]) { matched = false; break; }
        }
        if (matched) rows.push([...lr, ...rr]);
      }
    }
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalAggregate(n: AggregateNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const groupIdx = n.groupBy.map((g) => inp.columns.findIndex((c) => c.name === g));
    const groups = new Map<string, { key: unknown[]; rows: ReadonlyArray<unknown>[] }>();
    for (const row of inp.rows) {
      const key = groupIdx.map((i) => row[i]);
      const k = JSON.stringify(key);
      const slot = groups.get(k) ?? { key, rows: [] };
      slot.rows.push(row);
      groups.set(k, slot);
    }
    const columns: MatColumnSpec[] = [
      ...n.groupBy.map((g): MatColumnSpec => ({ name: g, type: "STRING" })),
      ...n.aggregations.map((a): MatColumnSpec => ({ name: a.alias, type: "NUMBER" })),
    ];
    const rows: unknown[][] = [];
    const sortedKeys = [...groups.keys()].sort();
    for (const k of sortedKeys) {
      const slot = groups.get(k)!;
      const aggValues = n.aggregations.map((agg) => {
        const ci = agg.column ? inp.columns.findIndex((c) => c.name === agg.column) : -1;
        const values = ci >= 0 ? slot.rows.map((r) => Number(r[ci])).filter((v) => !Number.isNaN(v)) : [];
        switch (agg.fn) {
          case "count": return slot.rows.length;
          case "sum":   return values.reduce((a, b) => a + b, 0);
          case "avg":   return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
          case "min":   return values.length === 0 ? 0 : Math.min(...values);
          case "max":   return values.length === 0 ? 0 : Math.max(...values);
        }
      });
      rows.push([...slot.key, ...aggValues]);
    }
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalPivot(n: PivotNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const rowIdx = n.rows.map((r) => inp.columns.findIndex((c) => c.name === r));
    const colIdx = inp.columns.findIndex((c) => c.name === n.cols);
    const valIdx = inp.columns.findIndex((c) => c.name === n.value);
    if (rowIdx.some((i) => i < 0) || colIdx < 0 || valIdx < 0) throw new Error(`Pivot column missing`);
    const colVals = [...new Set(inp.rows.map((r) => String(r[colIdx])))].sort();
    const groups = new Map<string, { key: unknown[]; cells: Record<string, number[]> }>();
    for (const row of inp.rows) {
      const key = rowIdx.map((i) => row[i]);
      const k = JSON.stringify(key);
      const slot = groups.get(k) ?? { key, cells: {} };
      const cv = String(row[colIdx]);
      slot.cells[cv] = slot.cells[cv] ?? [];
      slot.cells[cv].push(Number(row[valIdx]));
      groups.set(k, slot);
    }
    const columns: MatColumnSpec[] = [
      ...n.rows.map((r): MatColumnSpec => ({ name: r, type: "STRING" })),
      ...colVals.map((v): MatColumnSpec => ({ name: v, type: "NUMBER" })),
    ];
    const rows: unknown[][] = [];
    for (const k of [...groups.keys()].sort()) {
      const slot = groups.get(k)!;
      const cells = colVals.map((cv) => {
        const arr = slot.cells[cv] ?? [];
        if (arr.length === 0) return 0;
        switch (n.fn) {
          case "count": return arr.length;
          case "sum":   return arr.reduce((a, b) => a + b, 0);
          case "avg":   return arr.reduce((a, b) => a + b, 0) / arr.length;
          case "min":   return Math.min(...arr);
          case "max":   return Math.max(...arr);
        }
      });
      rows.push([...slot.key, ...cells]);
    }
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalExpression(n: ExpressionNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const expr = n.expression.trim();
    // Supported micro-syntax for tests: "<col> + <col>", "<col> * <num>", "<col>"
    const compute = compileExpression(expr, inp.columns);
    const newCol: MatColumnSpec = { name: n.column, type: "NUMBER" };
    const columns: MatColumnSpec[] = [...inp.columns, newCol];
    const rows = inp.rows.map((r) => [...r, compute(r)]);
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  private evalOrderBy(n: OrderByNode, ev: (id: string) => MatResult): MatResult {
    const inp = ev(n.input);
    const idxs = n.orderings.map((o) => ({
      i: inp.columns.findIndex((c) => c.name === o.column),
      dir: o.direction,
    }));
    const rows = [...inp.rows].sort((a, b) => {
      for (const { i, dir } of idxs) {
        const av = a[i] as any;
        const bv = b[i] as any;
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
    return { columns: inp.columns, rows, arrowBytes: estArrow(inp.columns, rows) };
  }
}

function evalPredicate(p: { op: string; args: readonly unknown[] }, row: ReadonlyArray<unknown>, colIdx: (col: string) => number): boolean {
  switch (p.op) {
    case "eq": {
      const [col, val] = p.args as [string, unknown];
      return row[colIdx(col)] === val;
    }
    case "neq": {
      const [col, val] = p.args as [string, unknown];
      return row[colIdx(col)] !== val;
    }
    case "gt": {
      const [col, val] = p.args as [string, number];
      return Number(row[colIdx(col)]) > val;
    }
    case "lt": {
      const [col, val] = p.args as [string, number];
      return Number(row[colIdx(col)]) < val;
    }
    case "in": {
      const [col, vals] = p.args as [string, unknown[]];
      return vals.includes(row[colIdx(col)]);
    }
    default: throw new Error(`Unsupported predicate: ${p.op}`);
  }
}

function compileExpression(expr: string, columns: readonly MatColumnSpec[]): (row: ReadonlyArray<unknown>) => number {
  // Match `a + b`, `a - b`, `a * b`, `a / b` (single binary op, columns or numeric literals)
  const m = /^(\w+)\s*([+\-*/])\s*(\S+)$/.exec(expr);
  if (m) {
    const [, lhs, op, rhs] = m;
    const lhsIdx = columns.findIndex((c) => c.name === lhs);
    const rhsIdx = columns.findIndex((c) => c.name === rhs);
    const rhsLit = Number(rhs);
    return (row) => {
      const a = lhsIdx >= 0 ? Number(row[lhsIdx]) : Number(lhs);
      const b = rhsIdx >= 0 ? Number(row[rhsIdx]) : rhsLit;
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? 0 : a / b;
        default:  return 0;
      }
    };
  }
  // bare column reference
  const i = columns.findIndex((c) => c.name === expr);
  if (i >= 0) return (row) => Number(row[i]);
  // numeric literal
  const lit = Number(expr);
  return () => lit;
}

function estArrow(columns: readonly MatColumnSpec[], rows: ReadonlyArray<ReadonlyArray<unknown>>): number {
  // Approximate Arrow IPC overhead: 8 bytes per cell + 64-byte header.
  return 64 + columns.length * 16 + rows.length * columns.length * 8;
}

function finalise(result: MatResult): MatResult {
  return { columns: result.columns, rows: result.rows, arrowBytes: estArrow(result.columns, result.rows) };
}
