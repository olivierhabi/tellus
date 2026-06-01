// ---------------------------------------------------------------------------
// B3 — Schema discovery against PostgreSQL (spec §B3 lines 138, 165).
//
// All queries are parameterized; ordering deterministic
// (schema_name, table_name, ordinal_position); keyset pagination on
// (schema_name, table_name) page size 200.
//
// Exports the six discovery primitives B3 names:
//   discoverCatalog, discoverSchemas, discoverTables, discoverColumns,
//   discoverPrimaryKeys, discoverImportedKeys.
//
// Each emits Tellus-canonical shapes that downstream B5 import planner and
// B10 FK-suggester consume directly.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { getPool } from "./pool";
import { mapOidToTellus, type TellusType } from "./type-mapping";

const PAGE_SIZE_DEFAULT = 200;

const SYSTEM_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
]);

export interface DiscoveredCatalog {
  catalog: string;
}

export interface DiscoveredSchema {
  catalog: string;
  schemaName: string;
}

export interface DiscoveredTable {
  schemaName: string;
  tableName: string;
  tableType: "TABLE" | "VIEW" | "MATERIALIZED VIEW" | "FOREIGN TABLE";
  /** Estimated row count (pg_class.reltuples); -1 if unavailable. */
  estimatedRowCount: number;
}

export interface DiscoveredColumn {
  schemaName: string;
  tableName: string;
  columnName: string;
  ordinalPosition: number;
  pgOid: number;
  pgType: string;
  notNull: boolean;
  defaultExpr: string | null;
  tellusType: TellusType;
}

export interface DiscoveredPrimaryKey {
  schemaName: string;
  tableName: string;
  constraintName: string;
  columnNames: string[];
}

export interface DiscoveredImportedKey {
  schemaName: string;
  tableName: string;
  constraintName: string;
  columnNames: string[];
  refSchemaName: string;
  refTableName: string;
  refColumnNames: string[];
  updateRule: string;
  deleteRule: string;
}

export interface Page<T> {
  rows: T[];
  /** Cursor to pass to the next call; null when no more pages. */
  nextCursor: { schema: string; table: string } | null;
}

// ---------------------------------------------------------------------------

export async function discoverCatalog(
  connectionRid: string,
): Promise<DiscoveredCatalog> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{ catalog: string }>(
    "SELECT current_database() AS catalog",
  );
  return { catalog: r.rows[0].catalog };
}

export async function discoverSchemas(
  connectionRid: string,
): Promise<DiscoveredSchema[]> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{ catalog: string; schema_name: string }>(
    `SELECT current_database() AS catalog, schema_name
       FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name ASC`,
  );
  return r.rows.map((row) => ({
    catalog: row.catalog,
    schemaName: row.schema_name,
  }));
}

export async function discoverTables(
  connectionRid: string,
  opts: {
    schemaName?: string;
    cursor?: { schema: string; table: string } | null;
    pageSize?: number;
  } = {},
): Promise<Page<DiscoveredTable>> {
  const pool = await getPool(connectionRid);
  const limit = Math.min(opts.pageSize ?? PAGE_SIZE_DEFAULT, 1000);
  const params: unknown[] = [limit + 1];
  let where = `WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
                 AND n.nspname NOT LIKE 'pg_temp_%'
                 AND n.nspname NOT LIKE 'pg_toast_temp_%'
                 AND c.relkind IN ('r','v','m','f')`;
  if (opts.schemaName) {
    params.push(opts.schemaName);
    where += ` AND n.nspname = $${params.length}`;
  }
  if (opts.cursor) {
    params.push(opts.cursor.schema, opts.cursor.table);
    where += ` AND (n.nspname, c.relname) > ($${params.length - 1}, $${params.length})`;
  }
  const r = await pool.query<{
    schema_name: string;
    table_name: string;
    relkind: string;
    reltuples: string;
  }>(
    `SELECT n.nspname AS schema_name,
            c.relname AS table_name,
            c.relkind,
            c.reltuples::text AS reltuples
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       ${where}
      ORDER BY n.nspname ASC, c.relname ASC
      LIMIT $1`,
    params,
  );
  const slice = r.rows.slice(0, limit);
  const more = r.rows.length > limit;
  const last = slice[slice.length - 1];
  return {
    rows: slice.map((row) => ({
      schemaName: row.schema_name,
      tableName: row.table_name,
      tableType: relkindToType(row.relkind),
      estimatedRowCount: Math.max(-1, Math.trunc(Number(row.reltuples))),
    })),
    nextCursor:
      more && last
        ? {
            schema: last.schema_name,
            table: last.table_name,
          }
        : null,
  };
}

function relkindToType(k: string): DiscoveredTable["tableType"] {
  switch (k) {
    case "v":
      return "VIEW";
    case "m":
      return "MATERIALIZED VIEW";
    case "f":
      return "FOREIGN TABLE";
    default:
      return "TABLE";
  }
}

export async function discoverColumns(
  connectionRid: string,
  schemaName: string,
  tableName: string,
): Promise<DiscoveredColumn[]> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{
    column_name: string;
    ordinal_position: number;
    atttypid: number;
    pg_type: string;
    atttypmod: number;
    attnotnull: boolean;
    default_expr: string | null;
  }>(
    `SELECT a.attname AS column_name,
            a.attnum AS ordinal_position,
            a.atttypid::int AS atttypid,
            format_type(a.atttypid, a.atttypmod) AS pg_type,
            a.atttypmod AS atttypmod,
            a.attnotnull AS attnotnull,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relname = $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum ASC`,
    [schemaName, tableName],
  );
  return r.rows.map((row) => ({
    schemaName,
    tableName,
    columnName: row.column_name,
    ordinalPosition: row.ordinal_position,
    pgOid: row.atttypid,
    pgType: row.pg_type,
    notNull: row.attnotnull,
    defaultExpr: row.default_expr,
    tellusType: mapOidToTellus(row.atttypid, row.atttypmod),
  }));
}

export async function discoverPrimaryKeys(
  connectionRid: string,
  schemaName: string,
  tableName: string,
): Promise<DiscoveredPrimaryKey | null> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{
    constraint_name: string;
    column_name: string;
    ordinal_position: number;
  }>(
    `SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
      WHERE tc.table_schema = $1
        AND tc.table_name = $2
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position ASC`,
    [schemaName, tableName],
  );
  if (r.rows.length === 0) return null;
  return {
    schemaName,
    tableName,
    constraintName: r.rows[0].constraint_name,
    columnNames: r.rows.map((row) => row.column_name),
  };
}

export async function discoverImportedKeys(
  connectionRid: string,
  schemaName: string,
  tableName: string,
): Promise<DiscoveredImportedKey[]> {
  const pool = await getPool(connectionRid);
  const r = await pool.query<{
    constraint_name: string;
    column_name: string;
    ordinal_position: number;
    ref_schema: string;
    ref_table: string;
    ref_column: string;
    update_rule: string;
    delete_rule: string;
  }>(
    `SELECT rc.constraint_name,
            kcu.column_name,
            kcu.ordinal_position,
            kcu2.table_schema AS ref_schema,
            kcu2.table_name AS ref_table,
            kcu2.column_name AS ref_column,
            rc.update_rule,
            rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.key_column_usage kcu
         ON rc.constraint_schema = kcu.constraint_schema
        AND rc.constraint_name = kcu.constraint_name
       JOIN information_schema.key_column_usage kcu2
         ON rc.unique_constraint_schema = kcu2.constraint_schema
        AND rc.unique_constraint_name = kcu2.constraint_name
        AND kcu2.ordinal_position = kcu.ordinal_position
      WHERE kcu.table_schema = $1
        AND kcu.table_name = $2
      ORDER BY rc.constraint_name ASC, kcu.ordinal_position ASC`,
    [schemaName, tableName],
  );
  const grouped = new Map<string, DiscoveredImportedKey>();
  for (const row of r.rows) {
    const k = row.constraint_name;
    const ex = grouped.get(k);
    if (ex) {
      ex.columnNames.push(row.column_name);
      ex.refColumnNames.push(row.ref_column);
    } else {
      grouped.set(k, {
        schemaName,
        tableName,
        constraintName: k,
        columnNames: [row.column_name],
        refSchemaName: row.ref_schema,
        refTableName: row.ref_table,
        refColumnNames: [row.ref_column],
        updateRule: row.update_rule,
        deleteRule: row.delete_rule,
      });
    }
  }
  return [...grouped.values()];
}

// ---------------------------------------------------------------------------
// Row preview — bounded SELECT used by the F3 "Explore source" surface to
// show sample rows before a sync exists. NOT a discovery primitive in the B3
// spec; added to back the configured-source explorer.
//
// Injection safety: the column identifiers are taken from discoverColumns
// (catalog-verified, parameterized) and the schema/table identifiers are
// quote-escaped via quoteIdent. The LIMIT is a bounded integer literal. No
// caller-supplied string is ever interpolated unquoted.
// ---------------------------------------------------------------------------

const PREVIEW_LIMIT_DEFAULT = 50;
const PREVIEW_LIMIT_MAX = 500;

export interface PreviewColumn {
  columnName: string;
  pgType: string;
  tellusType: TellusType;
}

export interface PreviewResult {
  schemaName: string;
  tableName: string;
  columns: PreviewColumn[];
  rows: Record<string, unknown>[];
}

/**
 * Quotes a PostgreSQL identifier: wrap in double quotes and double any
 * embedded double quotes. This is the canonical defense against identifier
 * injection (a column/table named `x"; DROP TABLE y; --` becomes inert).
 */
function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

export async function discoverPreviewRows(
  connectionRid: string,
  schemaName: string,
  tableName: string,
  limit: number = PREVIEW_LIMIT_DEFAULT,
): Promise<PreviewResult> {
  // Columns come from the catalog (parameterized). This both gives us the
  // typed column list for the response and validates that the relation
  // exists before we build any dynamic SQL against it.
  const cols = await discoverColumns(connectionRid, schemaName, tableName);
  if (cols.length === 0) {
    return { schemaName, tableName, columns: [], rows: [] };
  }
  const capped = Math.max(
    1,
    Math.min(Math.trunc(limit) || PREVIEW_LIMIT_DEFAULT, PREVIEW_LIMIT_MAX),
  );
  const colList = cols.map((c) => quoteIdent(c.columnName)).join(", ");
  const relation = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
  const pool = await getPool(connectionRid);
  const r = await pool.query<Record<string, unknown>>(
    `SELECT ${colList} FROM ${relation} LIMIT ${capped}`,
  );
  return {
    schemaName,
    tableName,
    columns: cols.map((c) => ({
      columnName: c.columnName,
      pgType: c.pgType,
      tellusType: c.tellusType,
    })),
    rows: r.rows,
  };
}

/** Test escape hatch: run a query on the pool. */
export async function _execOnPool<T extends object = Record<string, unknown>>(
  connectionRid: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getPool(connectionRid);
  const client: PoolClient = await pool.connect();
  try {
    const r = await client.query<T>(sql, params);
    return r.rows;
  } finally {
    client.release();
  }
}
