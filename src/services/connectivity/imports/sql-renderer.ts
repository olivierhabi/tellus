// ---------------------------------------------------------------------------
// B5 — Safe SQL renderer + SELECT-only gate for TableImport queries.
//
// SECURITY CONTROL (production-grade). A user-supplied `customQuery` is run
// against the customer's source database by the sync worker. It MUST be a
// pure, read-only SELECT. Enforcement is parser-based (libpg-query → the real
// PostgreSQL grammar), NOT regex, and FAILS CLOSED: if the parser cannot run,
// the query is rejected (never silently downgraded to a keyword scan).
//
// `assertSelectOnly()` walks the full parse tree and rejects:
//   - more than one statement (stacked `;`)
//   - any top-level statement that is not a SelectStmt
//   - any nested write node anywhere (writable CTE: WITH x AS (INSERT/UPDATE/
//     DELETE/MERGE ...) SELECT ...), DDL, COPY, DO, SET/SHOW, transaction
//     control, LOCK, CREATE TABLE AS, etc.
//   - `SELECT ... INTO`  (intoClause — creates a table)
//   - `SELECT ... FOR UPDATE/SHARE` (lockingClause — takes row locks)
//   - side-effecting / filesystem / large-object / dblink / admin functions
//     (pg_read_file, lo_*, dblink*, pg_sleep, set_config, pg_terminate_backend …)
//
// Defense-in-depth (enforced by callers, not here): every extraction runs in a
// `BEGIN; SET TRANSACTION READ ONLY` block with a `statement_timeout`, so even
// a novel side-effect that slips the denylist cannot write and cannot hang.
//
// `:last_watermark` is bound through pg's parameterized API ($1), never string
// substituted.
// ---------------------------------------------------------------------------

export interface RenderResult {
  /** SQL text with `:last_watermark` rewritten to `$1`. */
  sql: string;
  /** Bind parameters in positional order. */
  params: unknown[];
}

export class UnsafeSqlError extends Error {
  readonly statement: string;
  readonly reason: string;
  constructor(reason: string, statement: string) {
    super(`unsafe SQL rejected: ${reason}`);
    this.name = "UnsafeSqlError";
    this.reason = reason;
    this.statement = statement;
  }
}

// Node "tags" (the single key on a parse-tree node) that represent a write,
// DDL, or otherwise non-read-only operation. Rejected wherever they appear in
// the tree — this is what catches writable CTEs at any nesting depth.
const FORBIDDEN_NODE_TAGS = new Set<string>([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "CopyStmt",
  "DoStmt",
  "CallStmt",
  "TruncateStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSeqStmt",
  "CreateFunctionStmt",
  "CreateExtensionStmt",
  "CreateRoleStmt",
  "AlterTableStmt",
  "AlterSeqStmt",
  "AlterRoleStmt",
  "AlterDatabaseStmt",
  "AlterSystemStmt",
  "DropStmt",
  "RenameStmt",
  "IndexStmt",
  "RuleStmt",
  "ViewStmt",
  "DefineStmt",
  "GrantStmt",
  "GrantRoleStmt",
  "ReindexStmt",
  "VacuumStmt",
  "ClusterStmt",
  "LockStmt",
  "VariableSetStmt", // SET / RESET
  "VariableShowStmt", // SHOW
  "TransactionStmt", // BEGIN / COMMIT / ROLLBACK / SAVEPOINT
  "PrepareStmt",
  "ExecuteStmt",
  "DeallocateStmt",
  "ExplainStmt", // EXPLAIN ANALYZE executes; reject outright for extraction
  "CreatedbStmt",
  "DropdbStmt",
  "CreateTrigStmt",
  "CreatePolicyStmt",
]);

// Side-effecting / filesystem / large-object / dblink / admin functions. The
// READ-ONLY transaction is the real backstop; this denylist gives an explicit,
// early, friendly rejection for the well-known dangerous ones.
const FORBIDDEN_FUNCTIONS = new Set<string>([
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_ls_logdir",
  "pg_ls_waldir",
  "pg_ls_tmpdir",
  "pg_stat_file",
  "pg_read_server_files",
  "lo_import",
  "lo_export",
  "lo_get",
  "lo_put",
  "lo_creat",
  "lo_create",
  "lo_from_bytea",
  "lo_unlink",
  "loread",
  "lowrite",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "dblink_open",
  "dblink_send_query",
  "set_config",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_logical_emit_message",
  "pg_create_restore_point",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_advisory_xact_lock",
  "pg_advisory_unlock_all",
  "pg_import_system_collations",
]);

// Belt-and-suspenders keyword denylist (secondary layer; the AST walk is
// authoritative). Comments stripped first.
const FORBIDDEN_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "TRUNCATE", "DROP",
  "CREATE", "ALTER", "GRANT", "REVOKE", "CALL", "DO", "VACUUM", "REINDEX",
  "CLUSTER", "LOCK", "PREPARE", "EXECUTE", "DEALLOCATE",
];

/**
 * Parse-based SELECT-only gate. Throws {@link UnsafeSqlError} on anything that
 * is not a single pure read-only SELECT. FAILS CLOSED when the parser cannot
 * run (unless TELLUS_ALLOW_REGEX_SQL_FALLBACK=1 is explicitly set for a
 * constrained runtime — defaults off).
 */
export async function assertSelectOnly(rawSql: string): Promise<void> {
  const sql = (rawSql ?? "").trim();
  if (!sql) throw new UnsafeSqlError("empty query", rawSql ?? "");

  // Normalize the one supported bind placeholder to a real positional param so
  // the grammar accepts it (`:last_watermark` is not valid SQL; `$1` is). The
  // actual value binding happens in bindLastWatermark for execution.
  const parseable = sql.replace(/:last_watermark\b/g, "$1");

  let stmts: unknown[] | null = null;
  let parserError: unknown = null;
  try {
    const mod: any = await import("libpg-query");
    const parseFn = mod.parse ?? mod.parseQuery ?? mod.default?.parse;
    const parsed = await parseFn(parseable);
    stmts = parsed?.stmts ?? parsed?.parse_tree?.stmts ?? null;
    if (!Array.isArray(stmts)) {
      throw new UnsafeSqlError("parser returned unexpected shape", sql);
    }
  } catch (err) {
    if (err instanceof UnsafeSqlError) throw err;
    parserError = err;
  }

  if (stmts === null) {
    // Parser unavailable or threw (e.g. syntax error). Fail closed.
    if (process.env.TELLUS_ALLOW_REGEX_SQL_FALLBACK === "1") {
      // Explicit, documented escape hatch for runtimes without the WASM
      // binding. Still applies the keyword denylist (never "allow all").
      enforceKeywordDenylist(sql);
      return;
    }
    throw new UnsafeSqlError(
      `parser unavailable or query unparseable: ${
        parserError instanceof Error ? parserError.message : String(parserError)
      }`,
      sql,
    );
  }

  if (stmts.length === 0) throw new UnsafeSqlError("no statement", sql);
  if (stmts.length > 1) {
    throw new UnsafeSqlError("multiple statements are not allowed", sql);
  }

  const top = unwrapStmt(stmts[0]);
  const topTag = nodeTag(top);
  if (topTag !== "SelectStmt") {
    throw new UnsafeSqlError(`only SELECT is allowed (saw ${topTag})`, sql);
  }

  // Recursively walk the whole tree. The AST is authoritative; we deliberately
  // do NOT also run the keyword denylist here — once the parser has proven the
  // statement is a single pure SELECT, a keyword scan would only create false
  // positives (e.g. the literal 'CREATE' in a WHERE clause, a column named
  // "update"). The denylist is reserved for the parser-unavailable fallback.
  walk(top, sql);
}

export async function renderQuery(
  rawSql: string,
  bindings: { lastWatermark?: unknown },
): Promise<RenderResult> {
  await assertSelectOnly(rawSql);
  return bindLastWatermark(rawSql, bindings.lastWatermark);
}

// --- AST helpers -------------------------------------------------------------

function unwrapStmt(s: unknown): unknown {
  // libpg-query wraps each statement as { stmt: <node>, stmt_len, stmt_location }
  if (s && typeof s === "object" && "stmt" in (s as Record<string, unknown>)) {
    return (s as Record<string, unknown>).stmt;
  }
  return s;
}

/** The node "tag" = the single PascalCase key naming the node type. */
function nodeTag(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const keys = Object.keys(node as Record<string, unknown>);
  return keys.length > 0 ? keys[0] : "";
}

/** Recursively validate a parse (sub)tree. Throws on the first violation. */
function walk(node: unknown, sql: string): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, sql);
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    // A keyed node whose tag is a forbidden statement type → reject.
    if (FORBIDDEN_NODE_TAGS.has(key)) {
      throw new UnsafeSqlError(`forbidden statement node: ${key}`, sql);
    }

    if (key === "SelectStmt" && value && typeof value === "object") {
      const sel = value as Record<string, unknown>;
      if (sel.intoClause) {
        throw new UnsafeSqlError("SELECT ... INTO is not allowed", sql);
      }
      if (sel.lockingClause) {
        throw new UnsafeSqlError(
          "SELECT ... FOR UPDATE/SHARE is not allowed",
          sql,
        );
      }
    }

    if (key === "FuncCall" && value && typeof value === "object") {
      const fn = funcName(value as Record<string, unknown>);
      if (fn && FORBIDDEN_FUNCTIONS.has(fn)) {
        throw new UnsafeSqlError(`forbidden function: ${fn}()`, sql);
      }
    }

    walk(value, sql);
  }
}

/** Extract the (last component of the) function name from a FuncCall node. */
function funcName(funcCall: Record<string, unknown>): string | null {
  const parts = funcCall.funcname;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const last = parts[parts.length - 1] as Record<string, unknown>;
  const str = (last?.String ?? last) as Record<string, unknown> | undefined;
  const name = (str?.sval ?? str?.str) as string | undefined;
  return typeof name === "string" ? name.toLowerCase() : null;
}

function enforceKeywordDenylist(sql: string): void {
  const stripped = sql
    .replace(/--.*?$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const upper = stripped.toUpperCase();
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(?:^|[^A-Z0-9_])${kw}(?:$|[^A-Z0-9_])`);
    if (re.test(upper)) {
      throw new UnsafeSqlError(`forbidden keyword: ${kw}`, sql);
    }
  }
}

function bindLastWatermark(
  sql: string,
  value: unknown,
): { sql: string; params: unknown[] } {
  const hits = (sql.match(/:last_watermark\b/g) ?? []).length;
  if (hits === 0) return { sql, params: [] };
  const rewritten = sql.replace(/:last_watermark\b/g, "$1");
  return { sql: rewritten, params: [value ?? null] };
}
