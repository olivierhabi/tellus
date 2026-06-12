// ---------------------------------------------------------------------------
// Spark MatAdapter — FOUNDRY-GAPS §1 (mirrors trinoAdapter.ts / flinkAdapter.ts).
//
// Implements the `MatPort.sparkExecute` tier against Apache Livy's REST API
// (open-source, self-hostable Spark gateway):
//   POST /sessions                       → create (or reuse an idle) session
//   GET  /sessions/{id}                  → poll until state=idle
//   POST /sessions/{id}/statements       → submit the compiled SQL / code
//   GET  /sessions/{id}/statements/{sid} → poll until state=available
//
// Env-gated exactly like the Trino adapter: the production context only
// selects this adapter when LIVY_URL is set (see defaultMatPortFromEnv);
// dev/test environments never dial out and keep the in-process evaluator.
//
// All non-spark MatPort methods (pinSnapshots, polarsExecute,
// estimateCardinality) delegate to an inner MatPort (composition, not
// duplication) — by default the InProcessMatAdapter, until the real Polars
// sidecar / Iceberg metadata service are wired (D-50).
//
// Plan translation: the common relational subset (scan / project / filter /
// join / aggregate / orderBy) compiles to Spark SQL. `pivot` and
// `expression` nodes (free-form micro-syntax, see inProcessMat.ts) do NOT
// translate; they throw a typed SPARK_PLAN_NOT_SUPPORTED so callers can
// fall back to the in-process tier without silently computing the wrong
// answer. This keeps the polars-vs-spark tiering contract (matBackend.ts
// selectTier) honest: same plan, same semantics, different engine.
// ---------------------------------------------------------------------------

import { AppError } from "../../../../utils/foundryAppError";
import {
  MatLimitExceededError,
  type MatExecuteContext,
  type MatPort,
  type MatResult,
  type MatColumnSpec,
} from "./matPort";
import type {
  CalcitePlan,
  CalciteNode,
  AggregateNode,
  FilterNode,
  JoinNode,
  OrderByNode,
  ProjectNode,
  ScanNode,
} from "./calcitePlan";
import { InProcessMatAdapter } from "./inProcessMat";

// Mirrors TRANSFORM_TABLE_ROW_LIMIT in inProcessMat.ts — the result-size
// contract is tier-independent (B7), so the Spark tier enforces it too.
const TRANSFORM_TABLE_ROW_LIMIT = 50_000;

export interface SparkMatAdapterConfig {
  /** Livy base URL, e.g. http://localhost:8998 */
  url: string;
  /** "sql" (Livy thriftserver-style SQL session) or "spark" (Scala). */
  sessionKind: "sql" | "spark";
  /** End-to-end budget for one sparkExecute (session + statement). */
  statementTimeoutMs: number;
  /** Poll cadence against Livy. Overridable so tests don't sleep. */
  pollIntervalMs: number;
}

export function sparkConfigFromEnv(): SparkMatAdapterConfig {
  const kind = process.env.LIVY_SESSION_KIND === "spark" ? "spark" : "sql";
  return {
    url: (process.env.LIVY_URL ?? "http://localhost:8998").replace(/\/+$/, ""),
    sessionKind: kind,
    statementTimeoutMs: Number(
      process.env.SPARK_STATEMENT_TIMEOUT_MS ?? "1800000", // 30 min
    ),
    pollIntervalMs: Number(process.env.LIVY_POLL_INTERVAL_MS ?? "1000"),
  };
}

// ---------------------------------------------------------------------------
// Plan → Spark SQL translation.
// ---------------------------------------------------------------------------

export interface CompiledSparkPlan {
  readonly sql: string;
  /** Output column shape, derived from the plan. Types are best-effort
   *  (scans carry no schema in the plan); Livy's response schema refines
   *  them when available. */
  readonly columns: readonly MatColumnSpec[];
}

/** Backtick-quote a Spark identifier (escapes embedded backticks). */
function ident(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new AppError(
        `Non-finite numeric literal in plan: ${v}`,
        422,
        "SPARK_PLAN_NOT_SUPPORTED",
      );
    }
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return "'" + v.replace(/'/g, "''") + "'";
  throw new AppError(
    `Unsupported literal type in plan predicate: ${typeof v}`,
    422,
    "SPARK_PLAN_NOT_SUPPORTED",
  );
}

function compilePredicate(p: FilterNode["predicate"]): string {
  switch (p.op) {
    case "eq": {
      const [col, val] = p.args as [string, unknown];
      return val === null ? `${ident(col)} IS NULL` : `${ident(col)} = ${literal(val)}`;
    }
    case "neq": {
      const [col, val] = p.args as [string, unknown];
      return val === null ? `${ident(col)} IS NOT NULL` : `${ident(col)} <> ${literal(val)}`;
    }
    case "gt": {
      const [col, val] = p.args as [string, number];
      return `${ident(col)} > ${literal(val)}`;
    }
    case "lt": {
      const [col, val] = p.args as [string, number];
      return `${ident(col)} < ${literal(val)}`;
    }
    case "in": {
      const [col, vals] = p.args as [string, unknown[]];
      if (!Array.isArray(vals) || vals.length === 0) return "FALSE";
      return `${ident(col)} IN (${vals.map(literal).join(", ")})`;
    }
    default:
      throw new AppError(
        `Predicate op "${p.op}" does not translate to Spark SQL`,
        422,
        "SPARK_PLAN_NOT_SUPPORTED",
      );
  }
}

const JOIN_SQL: Record<JoinNode["type"], string> = {
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
  outer: "FULL OUTER JOIN",
};

/**
 * Translate the Calcite plan to a single Spark SQL SELECT. Throws
 * SPARK_PLAN_NOT_SUPPORTED (422) for nodes outside the relational subset
 * (pivot, expression) so the caller can fall back to the in-process tier.
 *
 * Scan `datasetRid`s are addressed as backtick-quoted table identifiers —
 * production maps RIDs to catalog tables via Spark's Iceberg catalog,
 * where the RID is registered verbatim as the table name.
 */
export function compilePlanToSparkSql(plan: CalcitePlan): CompiledSparkPlan {
  const byId = new Map<string, CalciteNode>();
  for (const n of plan.nodes) byId.set(n.id, n);
  let alias = 0;
  const sub = (sql: string): string => `(${sql}) t${alias++}`;

  const compile = (id: string): CompiledSparkPlan => {
    const node = byId.get(id);
    if (!node) {
      throw new AppError(`Unknown plan node id: ${id}`, 422, "SPARK_PLAN_NOT_SUPPORTED");
    }
    switch (node.kind) {
      case "scan": return compileScan(node);
      case "project": return compileProject(node);
      case "filter": return compileFilter(node);
      case "join": return compileJoin(node);
      case "aggregate": return compileAggregate(node);
      case "orderBy": return compileOrderBy(node);
      case "pivot":
      case "expression":
        // The in-process evaluator implements these with a test micro-syntax
        // (see inProcessMat.ts compileExpression) that has no faithful SQL
        // equivalent — refusing is more honest than guessing.
        throw new AppError(
          `Plan node kind "${node.kind}" does not translate to Spark SQL`,
          422,
          "SPARK_PLAN_NOT_SUPPORTED",
        );
    }
  };

  const compileScan = (n: ScanNode): CompiledSparkPlan => ({
    sql: `SELECT ${n.columns.map(ident).join(", ")} FROM ${ident(n.datasetRid)}`,
    // Scans carry no schema in the plan — default STRING, refined by Livy.
    columns: n.columns.map((c) => ({ name: c, type: "STRING" as const })),
  });

  const compileProject = (n: ProjectNode): CompiledSparkPlan => {
    const inp = compile(n.input);
    const cols = n.columns.map((c) => {
      const found = inp.columns.find((ic) => ic.name === c);
      return { name: c, type: found?.type ?? ("STRING" as const) };
    });
    return {
      sql: `SELECT ${n.columns.map(ident).join(", ")} FROM ${sub(inp.sql)}`,
      columns: cols,
    };
  };

  const compileFilter = (n: FilterNode): CompiledSparkPlan => {
    const inp = compile(n.input);
    return {
      sql: `SELECT * FROM ${sub(inp.sql)} WHERE ${compilePredicate(n.predicate)}`,
      columns: inp.columns,
    };
  };

  const compileJoin = (n: JoinNode): CompiledSparkPlan => {
    const left = compile(n.left);
    const right = compile(n.right);
    const la = `t${alias++}`;
    const ra = `t${alias++}`;
    const on = n.on
      .map((o) => `${la}.${ident(o.leftCol)} = ${ra}.${ident(o.rightCol)}`)
      .join(" AND ");
    return {
      sql: `SELECT * FROM (${left.sql}) ${la} ${JOIN_SQL[n.type]} (${right.sql}) ${ra} ON ${on}`,
      columns: [...left.columns, ...right.columns],
    };
  };

  const compileAggregate = (n: AggregateNode): CompiledSparkPlan => {
    const inp = compile(n.input);
    const aggExprs = n.aggregations.map((a) => {
      if (a.fn !== "count" && !a.column) {
        // The in-process evaluator returns 0 for column-less sum/avg/min/max;
        // there is no sensible SQL counterpart, so refuse rather than guess.
        throw new AppError(
          `Aggregation "${a.fn}" without a column does not translate to Spark SQL`,
          422,
          "SPARK_PLAN_NOT_SUPPORTED",
        );
      }
      const arg = a.column ? ident(a.column) : "*";
      return `${a.fn.toUpperCase()}(${arg}) AS ${ident(a.alias)}`;
    });
    const selectList = [...n.groupBy.map(ident), ...aggExprs].join(", ");
    const groupClause = n.groupBy.length > 0 ? ` GROUP BY ${n.groupBy.map(ident).join(", ")}` : "";
    // Deterministic group order matches the in-process evaluator's sorted keys
    // so the plan-equivalence golden test (B7 C-05) compares equal.
    const orderClause = n.groupBy.length > 0 ? ` ORDER BY ${n.groupBy.map(ident).join(", ")}` : "";
    return {
      sql: `SELECT ${selectList} FROM ${sub(inp.sql)}${groupClause}${orderClause}`,
      columns: [
        ...n.groupBy.map((g): MatColumnSpec => ({ name: g, type: "STRING" })),
        ...n.aggregations.map((a): MatColumnSpec => ({ name: a.alias, type: "NUMBER" })),
      ],
    };
  };

  const compileOrderBy = (n: OrderByNode): CompiledSparkPlan => {
    const inp = compile(n.input);
    const order = n.orderings
      .map((o) => `${ident(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`)
      .join(", ");
    return {
      sql: `SELECT * FROM ${sub(inp.sql)} ORDER BY ${order}`,
      columns: inp.columns,
    };
  };

  return compile(plan.root);
}

// ---------------------------------------------------------------------------
// Livy wire types (subset we consume).
// ---------------------------------------------------------------------------

interface LivySession {
  id: number;
  kind?: string;
  state: string; // not_started | starting | idle | busy | shutting_down | error | dead | killed
}

interface LivyStatement {
  id: number;
  state: string; // waiting | running | available | error | cancelling | cancelled
  output?: {
    status?: "ok" | "error";
    ename?: string;
    evalue?: string;
    data?: Record<string, unknown>;
  };
}

interface LivySchemaField { name?: string; type?: string; dataType?: string }

function mapLivyType(t: string | undefined): MatColumnSpec["type"] {
  switch ((t ?? "").toLowerCase()) {
    case "boolean": return "BOOLEAN";
    case "byte": case "short": case "integer": case "int": case "long":
    case "bigint": case "float": case "double": case "decimal":
      return "NUMBER";
    case "timestamp": case "date":
      return "DATETIME";
    default:
      return "STRING";
  }
}

function estArrow(columns: readonly MatColumnSpec[], rows: ReadonlyArray<ReadonlyArray<unknown>>): number {
  // Same approximation as inProcessMat.ts so inline/blob decisions (B7 C-07)
  // are tier-independent.
  return 64 + columns.length * 16 + rows.length * columns.length * 8;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export class SparkMatAdapter implements MatPort {
  constructor(
    /** Handles pinSnapshots / polarsExecute / estimateCardinality. */
    private readonly inner: MatPort = new InProcessMatAdapter(),
    private readonly config: SparkMatAdapterConfig = sparkConfigFromEnv(),
  ) {}

  // ----- delegated (composition, not duplication) -----------------------

  pinSnapshots(plan: CalcitePlan, ctx: MatExecuteContext): Promise<Record<string, string>> {
    return this.inner.pinSnapshots(plan, ctx);
  }

  polarsExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult> {
    return this.inner.polarsExecute(plan, ctx);
  }

  estimateCardinality(plan: CalcitePlan, ctx: MatExecuteContext) {
    return this.inner.estimateCardinality(plan, ctx);
  }

  // ----- spark tier ------------------------------------------------------

  async sparkExecute(plan: CalcitePlan, ctx: MatExecuteContext): Promise<MatResult> {
    // Translate first — SPARK_PLAN_NOT_SUPPORTED must surface before any
    // network call so the fallback path costs nothing.
    const compiled = compilePlanToSparkSql(plan);

    // G-06: honour the caller's remaining deadline if tighter than ours.
    const budgetMs = Math.min(
      this.config.statementTimeoutMs,
      ctx.remainingMs ?? Number.POSITIVE_INFINITY,
    );
    const deadline = Date.now() + budgetMs;

    const sessionId = await this.ensureSession(ctx, deadline);
    const stmt = await this.runStatement(sessionId, compiled, ctx, deadline);
    return this.parseResult(compiled, stmt);
  }

  /** Reuse an idle session of the right kind if Livy lists one; else create
   *  one and poll until idle. */
  private async ensureSession(ctx: MatExecuteContext, deadline: number): Promise<number> {
    const listed = await this.http<{ sessions?: LivySession[] }>(
      "GET", "/sessions", undefined, ctx, "SPARK_UNAVAILABLE",
    );
    const idle = (listed.sessions ?? []).find(
      (s) => s.state === "idle" && (s.kind ?? this.config.sessionKind) === this.config.sessionKind,
    );
    if (idle) return idle.id;

    const created = await this.http<LivySession>(
      "POST", "/sessions", { kind: this.config.sessionKind }, ctx, "SPARK_SUBMIT_FAILED",
    );
    let session = created;
    while (session.state !== "idle") {
      if (session.state === "error" || session.state === "dead" || session.state === "killed") {
        throw new AppError(
          `Livy session ${session.id} entered terminal state "${session.state}"`,
          502,
          "SPARK_SUBMIT_FAILED",
        );
      }
      if (Date.now() > deadline) {
        throw new AppError(
          `Spark session ${created.id} not idle within ${this.config.statementTimeoutMs}ms`,
          504,
          "SPARK_STATEMENT_TIMEOUT",
        );
      }
      await sleep(this.config.pollIntervalMs);
      session = await this.http<LivySession>(
        "GET", `/sessions/${created.id}`, undefined, ctx, "SPARK_UNAVAILABLE",
      );
    }
    return session.id;
  }

  private async runStatement(
    sessionId: number,
    compiled: CompiledSparkPlan,
    ctx: MatExecuteContext,
    deadline: number,
  ): Promise<LivyStatement> {
    // "sql" sessions take the SQL verbatim; "spark" (Scala) sessions wrap it
    // in spark.sql(...) emitting one JSON object per row on stdout.
    const code = this.config.sessionKind === "sql"
      ? compiled.sql
      : `spark.sql("""${compiled.sql}""").toJSON.collect.foreach(println)`;

    let stmt = await this.http<LivyStatement>(
      "POST", `/sessions/${sessionId}/statements`, { code }, ctx, "SPARK_SUBMIT_FAILED",
    );
    while (stmt.state !== "available") {
      if (stmt.state === "error" || stmt.state === "cancelled" || stmt.state === "cancelling") {
        throw new AppError(
          `Spark statement ${stmt.id} entered terminal state "${stmt.state}"`,
          502,
          "SPARK_QUERY_FAILED",
        );
      }
      if (Date.now() > deadline) {
        throw new AppError(
          `Spark statement ${stmt.id} exceeded ${this.config.statementTimeoutMs}ms`,
          504,
          "SPARK_STATEMENT_TIMEOUT",
        );
      }
      await sleep(this.config.pollIntervalMs);
      stmt = await this.http<LivyStatement>(
        "GET", `/sessions/${sessionId}/statements/${stmt.id}`, undefined, ctx, "SPARK_UNAVAILABLE",
      );
    }
    if (stmt.output?.status === "error") {
      throw new AppError(
        `Spark query failed: ${stmt.output.ename ?? ""} ${stmt.output.evalue ?? ""}`.trim(),
        502,
        "SPARK_QUERY_FAILED",
      );
    }
    return stmt;
  }

  private parseResult(compiled: CompiledSparkPlan, stmt: LivyStatement): MatResult {
    const data = stmt.output?.data ?? {};
    let columns: MatColumnSpec[] = [...compiled.columns];
    let rows: unknown[][] = [];

    const json = data["application/json"] as
      | { schema?: { fields?: LivySchemaField[] }; data?: unknown[][] }
      | undefined;
    if (json && Array.isArray(json.data)) {
      // SQL-kind sessions: schema + row arrays. Livy's schema refines the
      // best-effort types from translation.
      const fields = json.schema?.fields ?? [];
      columns = compiled.columns.map((c, i) => ({
        name: c.name,
        type: fields[i] ? mapLivyType(fields[i].type ?? fields[i].dataType) : c.type,
      }));
      rows = json.data.map((r) => [...r]);
    } else if (typeof data["text/plain"] === "string") {
      // Scala-kind sessions: one JSON object per stdout line.
      rows = String(data["text/plain"])
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{"))
        .map((l) => {
          const obj = JSON.parse(l) as Record<string, unknown>;
          return columns.map((c) => obj[c.name] ?? null);
        });
    } else {
      throw new AppError(
        "Spark statement returned no parsable output payload",
        502,
        "SPARK_QUERY_FAILED",
      );
    }

    if (rows.length > TRANSFORM_TABLE_ROW_LIMIT) {
      throw new MatLimitExceededError(TRANSFORM_TABLE_ROW_LIMIT, rows.length);
    }
    return { columns, rows, arrowBytes: estArrow(columns, rows) };
  }

  /** One Livy HTTP round-trip. Network / non-2xx failures map to the given
   *  typed code (SPARK_UNAVAILABLE for reads, SPARK_SUBMIT_FAILED for
   *  submits). Propagates branch as X-Tellus-Branch per G-09. */
  private async http<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown | undefined,
    ctx: MatExecuteContext,
    failCode: "SPARK_UNAVAILABLE" | "SPARK_SUBMIT_FAILED",
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.url}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Tellus-Branch": ctx.branch,
          "X-Tellus-User": ctx.userSubject,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (cause) {
      throw new AppError(
        `Livy unreachable at ${this.config.url}: ${(cause as Error)?.message ?? cause}`,
        502,
        "SPARK_UNAVAILABLE",
      );
    }
    if (!res.ok) {
      throw new AppError(
        `Livy ${method} ${path} failed: HTTP ${res.status}`,
        502,
        failCode,
      );
    }
    return (await res.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Env-gated selection — same pattern as getTrinoEngine(). The production
// compute context calls this; tests keep injecting via setMatPortForTests.
// ---------------------------------------------------------------------------

/**
 * Returns the MatPort the production context should use: when LIVY_URL is
 * set, the Spark tier goes over Livy (wrapping the in-process adapter for
 * the other methods); otherwise everything stays in-process — zero behavior
 * change for unconfigured environments.
 */
export function defaultMatPortFromEnv(): MatPort {
  return process.env.LIVY_URL
    ? new SparkMatAdapter(new InProcessMatAdapter(), sparkConfigFromEnv())
    : new InProcessMatAdapter();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
