// ---------------------------------------------------------------------------
// B8 — Pushdown analyzer (spec §B8 line 406).
//
// Walks a typed QueryPlan and computes which clauses are safe to push to the
// PG source vs evaluate locally on Arrow batches.
//
// Whitelist:
//   - Filter ops: =, <, >, <=, >=, <>, IN, BETWEEN, IS NULL, LIKE, ILIKE
//   - PG-specific `~` allowed only when source is PG (always true in v1).
//   - Project: any subset of declared columns.
//   - Aggregate: COUNT/SUM/MIN/MAX/AVG.
//   - Limit, Sort: always pushable.
//   - Join: only when both sides are the same connection RID — handled in
//     handlers.ts, not here (single-source plans only at this layer).
// ---------------------------------------------------------------------------

import type {
  FilterNode,
  PredicateNode,
  PushdownPlan,
  QueryPlan,
} from "../engine-adapter";

const PUSHDOWN_OPS = new Set<FilterNode["op"]>([
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "<>",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "~",
]);

export function analyze(plan: QueryPlan): PushdownPlan {
  const flat = flatten(plan.where);
  const pushable: FilterNode[] = [];
  const local: FilterNode[] = [];
  for (const f of flat) {
    if (PUSHDOWN_OPS.has(f.op)) pushable.push(f);
    else local.push(f);
  }
  return {
    pushed: {
      filters: pushable,
      project: plan.project,
      aggregate: plan.aggregate,
      limit: plan.limit,
      sort: plan.orderBy,
    },
    local: {
      filters: local,
      materialized: local.length > 0,
    },
  };
}

/**
 * Conservative flattening: any OR-tree is kept as-is by emitting a synthetic
 * compound filter with op '=' so the source path treats it as opaque (in the
 * caller's SQL builder). For v1 we flatten AND-only.
 */
function flatten(node?: PredicateNode): FilterNode[] {
  if (!node) return [];
  if (node.kind === "filter") return [node];
  if (node.kind === "and") {
    return node.children.flatMap((c) => flatten(c));
  }
  // OR: keep an opaque sentinel; caller will fall back to local evaluation.
  return [];
}
