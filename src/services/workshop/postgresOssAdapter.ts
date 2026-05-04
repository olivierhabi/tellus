// =============================================================================
// PostgresOssAdapter — production-default WorkshopOssAdapter.
//
// Reads from the seeded `workshop_demo_order` table so that the editor at
// /workshop/{rid} renders the same rows + facet counts that the static demo
// at /workshop hardcodes. Migration 061 owns the table + seed.
//
// Behaviour:
//   * `objectTypeApiName === "order"` → real SQL against workshop_demo_order
//   * any other type → empty result (preserves recording-adapter degradation
//     for object types that aren't seeded yet, instead of throwing)
//   * "relation does not exist" → empty result (env without the seed
//     migration applied still boots; tests that swap setOss() are unaffected)
//
// §0.5 + §0.6: ctx.branchRid + ctx.jwt are accepted but unused — the demo
// table is single-branch. The OssAdapter contract still passes them through
// the request shape so a future multi-branch wiring is mechanical.
// =============================================================================

import { getWorkshopDb } from "./db.js";
import type { Predicate } from "./filterCompiler.js";
import type {
  OssAggregateRequest,
  OssAggregateResponse,
  OssLoadRequest,
  OssLoadResponse,
  OssRequestContext,
  WorkshopOssAdapter,
} from "./ossAdapter.js";

// Property api_name -> SQL column. Defensive whitelist; anything not here
// compiles to FALSE so we never reflect raw user input into SQL.
const COL_MAP: Readonly<Record<string, string>> = Object.freeze({
  id: "order_id",
  item_name: "item_name",
  order_due_date: "order_due_date",
  customer_id: "customer_id",
  consolidated_customer_id: "consolidated_customer_id",
  customer_name: "customer_name",
  status: "status",
  assignee: "assignee",
  quantity: "quantity",
});

function compilePredicate(p: Predicate, params: unknown[]): string {
  switch (p.type) {
    case "matchAll":
      return "TRUE";
    case "and":
      if (p.clauses.length === 0) return "TRUE";
      return "(" + p.clauses.map((c) => compilePredicate(c, params)).join(" AND ") + ")";
    case "or":
      if (p.clauses.length === 0) return "FALSE";
      return "(" + p.clauses.map((c) => compilePredicate(c, params)).join(" OR ") + ")";
    case "not":
      return "NOT (" + compilePredicate(p.clause, params) + ")";
    case "term": {
      const col = COL_MAP[p.field];
      if (!col) return "FALSE";
      params.push(p.value);
      return `${col} = $${params.length}`;
    }
    case "terms": {
      const col = COL_MAP[p.field];
      if (!col || p.values.length === 0) return "FALSE";
      const placeholders = p.values
        .map((v) => {
          params.push(v);
          return `$${params.length}`;
        })
        .join(", ");
      return `${col} IN (${placeholders})`;
    }
    case "wildcard": {
      const col = COL_MAP[p.field];
      if (!col) return "FALSE";
      params.push(p.value.replace(/\*/g, "%"));
      return `${col}::text ILIKE $${params.length}`;
    }
    case "range": {
      const col = COL_MAP[p.field];
      if (!col) return "FALSE";
      const parts: string[] = [];
      if (p.gte !== undefined) {
        params.push(p.gte);
        parts.push(`${col} >= $${params.length}`);
      }
      if (p.gt !== undefined) {
        params.push(p.gt);
        parts.push(`${col} > $${params.length}`);
      }
      if (p.lte !== undefined) {
        params.push(p.lte);
        parts.push(`${col} <= $${params.length}`);
      }
      if (p.lt !== undefined) {
        params.push(p.lt);
        parts.push(`${col} < $${params.length}`);
      }
      return parts.length ? "(" + parts.join(" AND ") + ")" : "TRUE";
    }
  }
}

function isMissingTable(err: unknown): boolean {
  // Postgres "undefined_table" error code is 42P01.
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "42P01");
}

const SEEDED_TYPES = new Set<string>(["order"]);

export class PostgresOssAdapter implements WorkshopOssAdapter {
  async load(req: OssLoadRequest, _ctx: OssRequestContext): Promise<OssLoadResponse> {
    if (!SEEDED_TYPES.has(req.objectTypeApiName)) {
      return { objects: [], nextPageToken: null, totalEstimate: 0 };
    }
    const params: unknown[] = [];
    const where = compilePredicate(req.predicate, params);
    const orderBy =
      req.orderBy && req.orderBy.length > 0
        ? "ORDER BY " +
          req.orderBy
            .map((o) => {
              const col = COL_MAP[o.field] ?? "order_id";
              return `${col} ${o.direction === "desc" ? "DESC" : "ASC"}`;
            })
            .join(", ")
        : "ORDER BY order_due_date ASC, order_id ASC";
    const limit = Math.min(Math.max(req.pageSize, 1), 1000);

    try {
      const r = await getWorkshopDb().query(
        `SELECT
           order_id, item_name, order_due_date, customer_id,
           consolidated_customer_id, customer_name, status, assignee, quantity
         FROM workshop_demo_order
         WHERE ${where}
         ${orderBy}
         LIMIT ${limit + 1}`,
        params,
      );
      const objects = r.rows.slice(0, limit).map((row) => ({
        id: row.order_id,
        item_name: row.item_name,
        order_due_date:
          row.order_due_date instanceof Date
            ? row.order_due_date.toISOString()
            : row.order_due_date,
        customer_id: row.customer_id,
        consolidated_customer_id: row.consolidated_customer_id,
        customer_name: row.customer_name,
        status: row.status,
        assignee: row.assignee,
        quantity: row.quantity,
      }));
      const tot = await getWorkshopDb().query(
        `SELECT count(*)::int AS c FROM workshop_demo_order WHERE ${where}`,
        params,
      );
      return {
        objects,
        nextPageToken: r.rows.length > limit ? String(limit) : null,
        totalEstimate: tot.rows[0]?.c ?? objects.length,
      };
    } catch (err) {
      if (isMissingTable(err)) {
        return { objects: [], nextPageToken: null, totalEstimate: 0 };
      }
      throw err;
    }
  }

  async aggregate(
    req: OssAggregateRequest,
    _ctx: OssRequestContext,
  ): Promise<OssAggregateResponse> {
    if (!SEEDED_TYPES.has(req.objectTypeApiName)) {
      return { buckets: req.aggregations.map((a) => ({ name: a.name, groups: [] })) };
    }
    const out: {
      name: string;
      groups: { key: unknown; values: Record<string, number | null> }[];
    }[] = [];
    for (const agg of req.aggregations) {
      const col = COL_MAP[agg.property];
      if (!col) {
        out.push({ name: agg.name, groups: [] });
        continue;
      }
      const params: unknown[] = [];
      const where = compilePredicate(req.predicate, params);
      const limitClause =
        agg.groupBy?.kind === "topN"
          ? `LIMIT ${Math.max(1, Math.min(agg.groupBy.n, 100))}`
          : "";
      try {
        const r = await getWorkshopDb().query(
          `SELECT ${col} AS k, count(*)::int AS c
             FROM workshop_demo_order
            WHERE ${where}
            GROUP BY ${col}
            ORDER BY c DESC
            ${limitClause}`,
          params,
        );
        out.push({
          name: agg.name,
          groups: r.rows.map((row) => ({
            key: row.k,
            values: { count: row.c },
          })),
        });
      } catch (err) {
        if (isMissingTable(err)) {
          out.push({ name: agg.name, groups: [] });
        } else {
          throw err;
        }
      }
    }
    return { buckets: out };
  }
}
