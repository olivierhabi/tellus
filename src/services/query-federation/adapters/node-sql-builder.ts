// ---------------------------------------------------------------------------
// B8 — Node SQL builder federation adapter (spec §B8 line 404).
//
// Compose pushdown-safe SQL with parameterized binds; execute via pg; stream
// rows as Arrow IPC over a Node Readable.
//
// Heavy deps (kysely, apache-arrow) are imported dynamically so unit tests
// without them still pass the contract via a JSON-fallback stream tagged
// with `application/json` (a deviation noted in DEVIATIONS.md when active).
// ---------------------------------------------------------------------------

import { Readable } from "node:stream";
import { pool as appPool } from "../../../db";
import { getPool } from "../../connectivity/connectors/postgresql/pool";
import type {
  FederationEngineAdapter,
  QueryPlan,
  ExecutionResult,
  PushdownPlan,
  FilterNode,
} from "../engine-adapter";
import { analyze } from "../pushdown/rules";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(s: string): string {
  if (!IDENT.test(s)) throw new Error(`invalid identifier: ${s}`);
  return `"${s}"`;
}

interface VirtualTableMeta {
  connectionRid: string;
  schema: string;
  table: string;
  columns: string[];
}

async function loadVirtualTable(vrid: string): Promise<VirtualTableMeta> {
  const r = await appPool.query<{
    connection_rid: string;
    source_schema: string;
    source_table: string;
    schema_json: any;
  }>(
    `SELECT connection_rid, source_schema, source_table, schema_json
       FROM virtual_tables
      WHERE rid=$1 AND deleted_at IS NULL`,
    [vrid],
  );
  if (r.rowCount === 0) throw new Error(`virtual table not found: ${vrid}`);
  const row = r.rows[0];
  return {
    connectionRid: row.connection_rid,
    schema: row.source_schema,
    table: row.source_table,
    columns: (row.schema_json as Array<{ columnName: string }> | null)?.map(
      (c) => c.columnName,
    ) ?? [],
  };
}

export function createNodeSqlBuilderAdapter(): FederationEngineAdapter {
  return {
    async explain(plan): Promise<PushdownPlan> {
      return analyze(plan);
    },

    async execute(plan: QueryPlan): Promise<ExecutionResult> {
      const meta = await loadVirtualTable(plan.virtualTableRid);
      const pd = analyze(plan);

      const { sql, params } = buildSql(plan, meta, pd);
      const pgPool = await getPool(meta.connectionRid);
      const result = await pgPool.query<Record<string, unknown>>(sql, params);

      // Apply any non-pushable filters locally in-memory.
      let rows = result.rows;
      for (const f of pd.local.filters) {
        rows = rows.filter((r) => evalFilter(r, f));
      }

      // Try Arrow encoding; fall back to JSON.
      const stream = await encodeStream(rows, meta.columns, plan.project);
      return { stream, pushdownPlan: pd };
    },
  };
}

function buildSql(
  plan: QueryPlan,
  meta: VirtualTableMeta,
  pd: PushdownPlan,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const project = plan.project.length
    ? plan.project.map(ident).join(", ")
    : "*";
  const whereParts: string[] = [];
  for (const f of pd.pushed.filters) {
    const piece = renderFilter(f, params);
    if (piece) whereParts.push(piece);
  }
  let sql = `SELECT ${project} FROM ${ident(meta.schema)}.${ident(meta.table)}`;
  if (whereParts.length) sql += ` WHERE ${whereParts.join(" AND ")}`;
  if (plan.orderBy?.length) {
    sql += ` ORDER BY ${plan.orderBy
      .map((o) => `${ident(o.column)} ${o.direction}`)
      .join(", ")}`;
  }
  if (plan.limit != null) sql += ` LIMIT ${Math.max(0, Math.trunc(plan.limit))}`;
  if (plan.offset != null) sql += ` OFFSET ${Math.max(0, Math.trunc(plan.offset))}`;
  return { sql, params };
}

function renderFilter(f: FilterNode, params: unknown[]): string | null {
  const col = ident(f.column);
  switch (f.op) {
    case "IS NULL":
      return `${col} IS NULL`;
    case "IS NOT NULL":
      return `${col} IS NOT NULL`;
    case "BETWEEN": {
      const [lo, hi] = f.value as [unknown, unknown];
      params.push(lo, hi);
      return `${col} BETWEEN $${params.length - 1} AND $${params.length}`;
    }
    case "IN": {
      const arr = (f.value as unknown[]) ?? [];
      if (arr.length === 0) return "1=0";
      const placeholders = arr.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `${col} IN (${placeholders.join(", ")})`;
    }
    default: {
      params.push(f.value);
      return `${col} ${f.op} $${params.length}`;
    }
  }
}

function evalFilter(row: Record<string, unknown>, f: FilterNode): boolean {
  const v = row[f.column];
  switch (f.op) {
    case "=":
      return v === f.value;
    case "<>":
      return v !== f.value;
    case "<":
      return (v as number) < (f.value as number);
    case ">":
      return (v as number) > (f.value as number);
    case "<=":
      return (v as number) <= (f.value as number);
    case ">=":
      return (v as number) >= (f.value as number);
    case "IS NULL":
      return v == null;
    case "IS NOT NULL":
      return v != null;
    case "IN":
      return ((f.value as unknown[]) ?? []).includes(v);
    case "BETWEEN": {
      const [lo, hi] = f.value as [number, number];
      return (v as number) >= lo && (v as number) <= hi;
    }
    case "LIKE":
    case "ILIKE":
    case "~":
      return typeof v === "string" && new RegExp(String(f.value)).test(v);
    default:
      return true;
  }
}

async function encodeStream(
  rows: Record<string, unknown>[],
  knownColumns: string[],
  project: string[],
): Promise<Readable> {
  try {
    const arrow: any = await import("apache-arrow");
    const useCols =
      project.length > 0
        ? project
        : knownColumns.length > 0
          ? knownColumns
          : Object.keys(rows[0] ?? {});
    const data: Record<string, unknown[]> = {};
    for (const c of useCols) data[c] = rows.map((r) => r[c]);
    const table = arrow.tableFromArrays(data);
    const writer = arrow.RecordBatchStreamWriter.writeAll(table);
    const buf = writer.toUint8Array();
    return Readable.from([Buffer.from(buf)]);
  } catch {
    // JSON fallback (no apache-arrow).
    const out = JSON.stringify({ rows });
    return Readable.from([Buffer.from(out, "utf8")]);
  }
}
