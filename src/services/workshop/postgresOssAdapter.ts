// =============================================================================
// PostgresOssAdapter — production-default WorkshopOssAdapter.
//
// Two read paths:
//
//   1. The seeded `order` demo type → real SQL against `workshop_demo_order`
//      (migration 061), preserving the exact rows + facet counts the static
//      demo at /workshop hardcodes. Columns are snake_case and whitelisted.
//
//   2. Every OTHER object type → the canonical `object_instances` table
//      (migration 012), which stores merged state for ANY ontology object
//      type as `(ontology_id, object_type_api_name, primary_key, properties
//      JSONB)`. This is what makes a user-created object type (e.g. one added
//      through the Ontology Manager) immediately queryable by the Workshop
//      editor's B05 _load / B08 _aggregate without a per-type code change.
//
// Degradation: a missing table (42P01) or an object type with no rows yields
// an empty result rather than throwing, so an env without the demo migration
// — or an ontology with no instances yet — still boots and renders cleanly.
//
// §0.5 + §0.6: ctx.branchRid + ctx.jwt are accepted but unused here — the
// demo + object_instances reads are single-branch. The contract still passes
// them through so a future multi-branch wiring is mechanical.
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

// ---------------------------------------------------------------------------
// Demo `order` path — column whitelist + snake_case predicate compiler.
// ---------------------------------------------------------------------------

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

const DEMO_ORDER_TYPE = "order";

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
    case "prefix": {
      const col = COL_MAP[p.field];
      if (!col) return "FALSE";
      params.push(`${p.value}%`);
      return `${col}::text ILIKE $${params.length}`;
    }
    case "isNull": {
      const col = COL_MAP[p.field];
      return col ? `${col} IS NULL` : "FALSE";
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

// ---------------------------------------------------------------------------
// Generic `object_instances` path — JSONB predicate compiler.
//
// Properties live in a JSONB bag keyed by the canonical (camelCase) property
// api name. Field names are bound as PARAMETERS to `properties ->> $n`, never
// interpolated, so there is no SQL-injection surface even though the schema
// is open. Comparisons are text-based by default (correct for string/id/enum
// and lexicographically correct for ISO timestamps); numeric bounds cast the
// JSONB text to numeric so range filters on numbers order correctly.
// ---------------------------------------------------------------------------

function jsonbField(field: string, params: unknown[]): string {
  params.push(field);
  return `(properties ->> $${params.length})`;
}

function compileJsonbPredicate(p: Predicate, params: unknown[]): string {
  switch (p.type) {
    case "matchAll":
      return "TRUE";
    case "and":
      if (p.clauses.length === 0) return "TRUE";
      return (
        "(" + p.clauses.map((c) => compileJsonbPredicate(c, params)).join(" AND ") + ")"
      );
    case "or":
      if (p.clauses.length === 0) return "FALSE";
      return (
        "(" + p.clauses.map((c) => compileJsonbPredicate(c, params)).join(" OR ") + ")"
      );
    case "not":
      return "NOT (" + compileJsonbPredicate(p.clause, params) + ")";
    case "term": {
      const lhs = jsonbField(p.field, params);
      params.push(String(p.value));
      return `${lhs} = $${params.length}`;
    }
    case "terms": {
      if (p.values.length === 0) return "FALSE";
      const lhs = jsonbField(p.field, params);
      const placeholders = p.values
        .map((v) => {
          params.push(String(v));
          return `$${params.length}`;
        })
        .join(", ");
      return `${lhs} IN (${placeholders})`;
    }
    case "wildcard": {
      const lhs = jsonbField(p.field, params);
      params.push(p.value.replace(/\*/g, "%"));
      return `${lhs} ILIKE $${params.length}`;
    }
    case "prefix": {
      const lhs = jsonbField(p.field, params);
      params.push(`${p.value}%`);
      return `${lhs} ILIKE $${params.length}`;
    }
    case "isNull": {
      const lhs = jsonbField(p.field, params);
      return `${lhs} IS NULL`;
    }
    case "range": {
      const lhs = jsonbField(p.field, params);
      const parts: string[] = [];
      const bound = (op: string, v: unknown) => {
        if (typeof v === "number") {
          params.push(v);
          parts.push(`${lhs}::numeric ${op} $${params.length}`);
        } else {
          params.push(String(v));
          parts.push(`${lhs} ${op} $${params.length}`);
        }
      };
      if (p.gte !== undefined) bound(">=", p.gte);
      if (p.gt !== undefined) bound(">", p.gt);
      if (p.lte !== undefined) bound("<=", p.lte);
      if (p.lt !== undefined) bound("<", p.lt);
      return parts.length ? "(" + parts.join(" AND ") + ")" : "TRUE";
    }
  }
}

// Extract the bare ontology UUID from a full RID
// (`ri.ontology.main.ontology.{uuid}`); pass a bare UUID through unchanged.
function ontologyUuid(ridOrId: string): string {
  const m = /ri\.ontology\.main\.ontology\.([0-9a-fA-F-]+)$/.exec(ridOrId);
  return m ? m[1]! : ridOrId;
}

function isMissingTable(err: unknown): boolean {
  // Postgres "undefined_table" error code is 42P01.
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "42P01");
}

export class PostgresOssAdapter implements WorkshopOssAdapter {
  async load(req: OssLoadRequest, _ctx: OssRequestContext): Promise<OssLoadResponse> {
    return req.objectTypeApiName === DEMO_ORDER_TYPE
      ? this.loadDemoOrder(req)
      : this.loadGeneric(req);
  }

  async aggregate(
    req: OssAggregateRequest,
    _ctx: OssRequestContext,
  ): Promise<OssAggregateResponse> {
    return req.objectTypeApiName === DEMO_ORDER_TYPE
      ? this.aggregateDemoOrder(req)
      : this.aggregateGeneric(req);
  }

  // ---- Demo `order` table -------------------------------------------------

  private async loadDemoOrder(req: OssLoadRequest): Promise<OssLoadResponse> {
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

  private async aggregateDemoOrder(
    req: OssAggregateRequest,
  ): Promise<OssAggregateResponse> {
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
          groups: r.rows.map((row) => ({ key: row.k, values: { count: row.c } })),
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

  // ---- Generic `object_instances` table -----------------------------------

  private async loadGeneric(req: OssLoadRequest): Promise<OssLoadResponse> {
    // params: $1 ontology uuid, $2 object type api name, then predicate, then orderBy.
    const params: unknown[] = [ontologyUuid(req.ontologyRid), req.objectTypeApiName];
    const where = compileJsonbPredicate(req.predicate, params);
    const orderBy =
      req.orderBy && req.orderBy.length > 0
        ? "ORDER BY " +
          req.orderBy
            .map((o) => {
              const lhs = jsonbField(o.field, params);
              return `${lhs} ${o.direction === "desc" ? "DESC" : "ASC"}`;
            })
            .join(", ")
        : "ORDER BY primary_key ASC";
    const limit = Math.min(Math.max(req.pageSize, 1), 1000);

    try {
      const r = await getWorkshopDb().query(
        `SELECT primary_key, properties, version, rid
           FROM object_instances
          WHERE ontology_id = $1::uuid
            AND object_type_api_name = $2
            AND ${where}
          ${orderBy}
          LIMIT ${limit + 1}`,
        params,
      );
      const objects = r.rows.slice(0, limit).map((row) => {
        const props = (row.properties ?? {}) as Record<string, unknown>;
        const version = Number(row.version);
        // Preserve the system identity/version envelope Workshop needs for
        // active-object bindings and optimistic concurrency. Returning only
        // user properties makes a selected table row look current while the
        // Action form has no authoritative token to protect its write.
        return {
          ...(row.rid ? { __rid: row.rid } : {}),
          __primaryKey: row.primary_key,
          ...(Number.isFinite(version) ? { __version: version } : {}),
          ...("id" in props ? {} : { id: row.primary_key }),
          ...props,
        };
      });
      // Recompute the count query with its OWN param array (the load query's
      // params include trailing orderBy bindings the count doesn't reference,
      // and Postgres rejects a bind with unreferenced extra params).
      const countParams: unknown[] = [
        ontologyUuid(req.ontologyRid),
        req.objectTypeApiName,
      ];
      const countWhere = compileJsonbPredicate(req.predicate, countParams);
      const tot = await getWorkshopDb().query(
        `SELECT count(*)::int AS c
           FROM object_instances
          WHERE ontology_id = $1::uuid
            AND object_type_api_name = $2
            AND ${countWhere}`,
        countParams,
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

  private async aggregateGeneric(
    req: OssAggregateRequest,
  ): Promise<OssAggregateResponse> {
    const out: {
      name: string;
      groups: { key: unknown; values: Record<string, number | null> }[];
    }[] = [];
    for (const agg of req.aggregations) {
      // $1 group property, $2 ontology uuid, $3 type, then predicate.
      const params: unknown[] = [
        agg.property,
        ontologyUuid(req.ontologyRid),
        req.objectTypeApiName,
      ];
      const where = compileJsonbPredicate(req.predicate, params);
      const limitClause =
        agg.groupBy?.kind === "topN"
          ? `LIMIT ${Math.max(1, Math.min(agg.groupBy.n, 100))}`
          : "";
      try {
        const r = await getWorkshopDb().query(
          `SELECT (properties ->> $1) AS k, count(*)::int AS c
             FROM object_instances
            WHERE ontology_id = $2::uuid
              AND object_type_api_name = $3
              AND ${where}
            GROUP BY (properties ->> $1)
            ORDER BY c DESC
            ${limitClause}`,
          params,
        );
        out.push({
          name: agg.name,
          groups: r.rows.map((row) => ({ key: row.k, values: { count: row.c } })),
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
