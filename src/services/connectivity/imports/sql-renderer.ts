// ---------------------------------------------------------------------------
// B5 — Safe SQL renderer for TableImport queries (spec §B5 line 254).
//
// Uses libpg-query-node to PARSE the query AST and REJECT any node of type
// INSERT/UPDATE/DELETE/COPY/TRUNCATE/DROP/CREATE/ALTER/GRANT/REVOKE/CALL/DO.
// `:last_watermark` is bound through pg's parameterized query API
// ($1 placeholder), NEVER string-substituted.
//
// If libpg-query-node is not installed (some dev environments lack the
// native binding), falls back to a regex-based denylist for the same
// statement keywords plus a manual `:last_watermark` -> `$1` rewrite.
// The regex path is documented as a fallback in DEFERRED.md.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "COPY",
  "TRUNCATE",
  "DROP",
  "CREATE",
  "ALTER",
  "GRANT",
  "REVOKE",
  "CALL",
  "DO ",
  "MERGE",
];

export interface RenderResult {
  /** SQL text with `:last_watermark` rewritten to `$1`. */
  sql: string;
  /** Bind parameters in positional order. */
  params: unknown[];
}

export class UnsafeSqlError extends Error {
  readonly statement: string;
  constructor(message: string, statement: string) {
    super(`unsafe SQL rejected: ${message}`);
    this.name = "UnsafeSqlError";
    this.statement = statement;
  }
}

export async function renderQuery(
  rawSql: string,
  bindings: { lastWatermark?: unknown },
): Promise<RenderResult> {
  await validateAst(rawSql);
  // Defensive keyword check even if AST passed — protects against parser
  // upgrades that re-categorize a statement.
  enforceKeywordDenylist(rawSql);
  const { sql, params } = bindLastWatermark(rawSql, bindings.lastWatermark);
  return { sql, params };
}

async function validateAst(sql: string): Promise<void> {
  try {
    // Dynamic import so missing native binding falls back to keyword check.
    const mod: any = await import("libpg-query");
    const parsed = await mod.parse(sql);
    if (!parsed || !Array.isArray(parsed.stmts)) {
      throw new UnsafeSqlError(
        "parser returned unexpected shape",
        sql,
      );
    }
    for (const s of parsed.stmts) {
      const stmtNode = s.stmt ?? s;
      const kind = Object.keys(stmtNode)[0] ?? "";
      if (!isReadOnlyStmtKind(kind)) {
        throw new UnsafeSqlError(`stmt kind ${kind} not permitted`, sql);
      }
    }
  } catch (err) {
    if (err instanceof UnsafeSqlError) throw err;
    // Native binding missing — fall through to keyword denylist only.
    // eslint-disable-next-line no-console
    console.warn(
      "[connectivity.imports.sql-renderer] libpg-query unavailable; using keyword fallback",
    );
  }
}

function isReadOnlyStmtKind(kind: string): boolean {
  return kind === "SelectStmt" || kind === "WithClause";
}

function enforceKeywordDenylist(sql: string): void {
  // Strip line + block comments before scanning.
  const stripped = sql
    .replace(/--.*?$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const upper = stripped.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    // Word-boundary match for keywords that are single tokens.
    const re = new RegExp(`(?:^|[^A-Z0-9_])${kw.trim()}(?:$|[^A-Z0-9_])`);
    if (re.test(upper)) {
      throw new UnsafeSqlError(`forbidden keyword: ${kw.trim()}`, sql);
    }
  }
}

function bindLastWatermark(
  sql: string,
  value: unknown,
): { sql: string; params: unknown[] } {
  // Only one bind site supported in v1 contract.
  const hits = (sql.match(/:last_watermark\b/g) ?? []).length;
  if (hits === 0) return { sql, params: [] };
  if (hits > 1) {
    // We still allow it; same value substituted at each position.
  }
  // Replace every occurrence with $1.
  const rewritten = sql.replace(/:last_watermark\b/g, "$1");
  return { sql: rewritten, params: [value ?? null] };
}
