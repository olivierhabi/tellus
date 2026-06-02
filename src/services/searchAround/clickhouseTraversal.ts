// ---------------------------------------------------------------------------
// ClickHouse traversal — Task B10 (fallback, hops > 100k)
//
// Expressed as a single ClickHouse SQL query that JOINs N link tables.
// The input is an anchored PK set on the first hop's source side and a
// chain of (link_type, direction) descriptors. ClickHouse returns the
// final PK set as JSONEachRow; we post-filter by markings in the caller.
//
// Template:
//   SELECT DISTINCT l{n}.target_pk AS pk
//   FROM link_X__r1__Y l1
//   INNER JOIN link_Y__r2__Z l2 ON l1.target_pk = l2.source_pk
//   ...
//   WHERE l1.source_pk IN (:anchor)
//   AND   arrayAll(x -> has(:user_markings, x), l1.markings)
//   AND   arrayAll(x -> has(:user_markings, x), l2.markings)
//   ...
//   LIMIT :cap
// ---------------------------------------------------------------------------

import { ClickHouseClient, getClickHouseClient } from "./clickhouseClient";
import {
  LinkTypeDescriptor,
  linkTableName,
} from "./linkMaterializedView";

export interface Hop {
  linkType: LinkTypeDescriptor;
}

export interface ClickHouseTraversalInput {
  anchorPks: string[];
  hops: Hop[];
  userMarkings: ReadonlySet<string>;
  /** Cap on returned PKs. Default 100_000, admin override up to 1_000_000. */
  maxRows?: number;
  client?: ClickHouseClient;
}

export interface ClickHouseTraversalResult {
  targetPks: string[];
  rowsScanned: number;
  cappedAtMax: boolean;
  durationMs: number;
  viaBackend: "clickhouse";
  sql: string;
}

export const DEFAULT_CAP = 100_000;
export const ADMIN_MAX_CAP = 1_000_000;

export async function runClickHouseTraversal(
  input: ClickHouseTraversalInput
): Promise<ClickHouseTraversalResult> {
  const started = Date.now();
  if (input.anchorPks.length === 0 || input.hops.length === 0) {
    return {
      targetPks: [],
      rowsScanned: 0,
      cappedAtMax: false,
      durationMs: 0,
      viaBackend: "clickhouse",
      sql: "",
    };
  }
  const cap = Math.min(input.maxRows ?? DEFAULT_CAP, ADMIN_MAX_CAP);
  const client = input.client ?? getClickHouseClient();

  const sql = buildTraversalSql({
    anchorPks: input.anchorPks,
    hops: input.hops,
    userMarkings: input.userMarkings,
    cap,
  });
  const rows = await client.exec<{ pk: string }>(sql);
  const targetPks = rows.map((r) => r.pk);
  return {
    targetPks,
    rowsScanned: rows.length,
    cappedAtMax: rows.length >= cap,
    durationMs: Date.now() - started,
    viaBackend: "clickhouse",
    sql,
  };
}

// ---------------------------------------------------------------------------
// buildTraversalSql() — public so tests can snapshot the SQL without
// needing a running ClickHouse.
// ---------------------------------------------------------------------------

export interface BuildTraversalSqlInput {
  anchorPks: string[];
  hops: Hop[];
  userMarkings: ReadonlySet<string>;
  cap: number;
}

export function buildTraversalSql(input: BuildTraversalSqlInput): string {
  const markingsLiteral = arrayStringLiteral(Array.from(input.userMarkings));
  const anchorLiteral = arrayStringLiteral(input.anchorPks);

  const joins: string[] = [];
  const markingClauses: string[] = [];

  input.hops.forEach((hop, i) => {
    const alias = `l${i + 1}`;
    const table = linkTableName(hop.linkType);
    if (i === 0) {
      joins.push(`FROM ${table} AS ${alias}`);
    } else {
      const prev = `l${i}`;
      joins.push(
        `INNER JOIN ${table} AS ${alias} ON ${prev}.target_pk = ${alias}.source_pk`
      );
    }
    markingClauses.push(
      `arrayAll(x -> has(${markingsLiteral}, x), ${alias}.markings)`
    );
  });

  const finalAlias = `l${input.hops.length}`;
  const selectExpr = `SELECT DISTINCT ${finalAlias}.target_pk AS pk`;
  const where = [
    `l1.source_pk IN ${anchorLiteral}`,
    ...markingClauses,
  ].join("\n  AND ");

  return [
    selectExpr,
    joins.join("\n"),
    `WHERE ${where}`,
    `LIMIT ${input.cap}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Array-literal helper. ClickHouse takes a tuple for IN lists; we use an
// array literal with explicit String quoting.
// ---------------------------------------------------------------------------

function arrayStringLiteral(items: string[]): string {
  if (items.length === 0) return "[]";
  // ClickHouse string literals honor C-style backslash escapes (\', \\, \n …)
  // in ADDITION to SQL-standard quote-doubling, so doubling `'` alone is not a
  // correct escape for this engine: a value containing a backslash could
  // desynchronize quoting. Escape the backslash FIRST, then the single quote,
  // so every metacharacter is neutralized regardless of which escape syntax
  // ClickHouse applies. (anchorPks/markings reaching here are user-derived.)
  const escaped = items
    .map((i) => `'${i.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`)
    .join(",");
  return `[${escaped}]`;
}
