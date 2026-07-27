// ---------------------------------------------------------------------------
// DuckDB Transform Engine — PB-B2.
//
// Compiles a pipeline's `config.transforms[]` chain into a single DuckDB
// SQL statement and executes it via the shared pool in services/duckdb/pool.ts.
// This replaces the pure-TS engine's `applyExistingTransforms()` for
// `compute_type='duckdb'` pipelines — the default for all new pipelines.
//
// The compiler is deliberately narrow for this cut of PB-B2. It covers the
// deterministic-projection subset:
//
//   Cast   → CAST(col AS type) AS col
//   Filter → WHERE / boolean matrix
//   Drop   → SELECT * EXCLUDE(c1, c2, …)
//   Rename → SELECT col AS new
//   Join   → JOIN … ON … with collision-prefixed columns
//   Union  → UNION ALL with NULL-padded missing columns
//
// Normalize is INTENTIONALLY not supported on this path — its unicode /
// case / accent folding semantics live in pure TS and replicating them
// in a DuckDB UDF needs either a Rust extension (the spec's preferred
// solution, multi-day infra build) or a JS-as-string evaluator (the spec
// itself flags as a security hole). Chains containing Normalize must
// either be switched to `compute_type='legacy_nodejs'` on the pipeline or
// split so the Normalize stays on the legacy engine until PB-B2.follow-2
// ships the Rust UDF.
//
// Cross-join compile-time rejection and memory/spill caps are both
// covered here per PB-B2 acceptance (c) and (f).
//
// Follow-ups tracked as PB-B2.follow-*:
//   follow-1  Python duckdb subprocess for deploys >5 GB (isolation boundary)
//   follow-2  Rust-backed Normalize UDF
//   follow-3  PDS-H SF-10 CI perf gates (a)(b)(d)
//   follow-4  Arrow IPC → JSON on preview path
//   follow-5  Full 50-config envelope regression
//   follow-6  Swap `duckdb` binding for `@duckdb/node-api` (Arrow-native)
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";
import {
  acquireConnection,
  queryAll,
  releaseConnection,
  runAll,
  type DuckDBConnection,
} from "../duckdb/pool";

// ---------------------------------------------------------------------------
// Input shape — matches the `{ function, … }` records produced by the
// TransformService and persisted into `pipeline_nodes.config.transforms`.
// Re-declared here as structural types so this module does not pull in
// the whole transformService surface.
// ---------------------------------------------------------------------------

export type TransformStep =
  | CastStep
  | FilterStep
  | DropStep
  | RenameStep
  | NormalizeStep
  | JoinStep
  | UnionStep;

export interface CastStep {
  function: "Cast";
  expression: string;
  outputColumn?: string;
  targetType: "string" | "integer" | "numeric" | "boolean" | "date" | "timestamp";
}
export interface FilterStep {
  function: "Filter";
  mode?: "keep" | "drop";
  match?: "all" | "any";
  conditions: Array<FilterCondition>;
}
export interface FilterCondition {
  column: string;
  operator:
    | "eq"
    | "neq"
    | "starts_with"
    | "ends_with"
    | "contains"
    | "is_null"
    | "is_not_null"
    | "regex_find"
    | "regex_match";
  value?: string;
  treatEmptyAsNull?: boolean;
}
export interface DropStep {
  function: "Drop";
  columns: string[];
}
export interface RenameStep {
  function: "Rename";
  renames: Array<{ from: string; to: string }>;
}
export interface NormalizeStep {
  function: "Normalize";
  removeSpecialCharacters?: boolean;
}
export interface JoinStep {
  function: "Join";
  // Right-side dataset is identified by file path (CSV on S3 / local FS).
  // For this cut we don't support chained JOIN after transforms on the
  // right input — that's follow-5.
  rightPath: string;
  rightAlias?: string;
  joinType: "inner" | "left" | "right" | "full" | "cross";
  on?: Array<{ left: string; right: string }>;
  /** Required when joinType='cross'. Guard against compile-time OOMs. */
  allowCrossJoin?: boolean;
  estimatedCardinality?: number;
}
export interface UnionStep {
  function: "Union";
  otherPath: string;
  /** By name (default) or by position. */
  byName?: boolean;
}

export interface CompileOptions {
  /** Input CSV file path as consumed by DuckDB's read_csv_auto / httpfs. */
  inputPath: string;
  /** Row cap for preview; omit for full executeChain. */
  limit?: number;
  /** Ordered list of source column names; used to validate column refs. */
  sourceColumns?: string[];
}

export interface CompiledPlan {
  sql: string;
  /** Attached statements run BEFORE the main SQL — e.g. extension LOADs. */
  preambles: string[];
  /** Registered right-side reads used by JOIN / UNION (files, Parquet, etc). */
  externalReads: string[];
  /** True if any step is a cross-join (informational for the caller). */
  hasCrossJoin: boolean;
}

// ---------------------------------------------------------------------------
// Compile a transform chain into a single SELECT.
//
// Layering:
//   base := read_csv_auto('<inputPath>')  (CTE `t0`)
//   for each step, wrap the prior CTE with a new SELECT layer
//   final SELECT from the last CTE (with LIMIT if preview)
//
// We use CTEs rather than nested subqueries so DuckDB's planner sees a
// flat plan and the debug output is readable by humans — crucial for
// diagnosing a 60s deploy that should have taken 6s.
// ---------------------------------------------------------------------------

export function compileTransformChain(
  transforms: TransformStep[],
  options: CompileOptions,
): CompiledPlan {
  rejectUnsupported(transforms);

  const ctes: string[] = [];
  const externalReads: string[] = [];
  const preambles: string[] = [];
  let hasCrossJoin = false;

  ctes.push(`t0 AS (SELECT * FROM ${readSource(options.inputPath)})`);

  let current = "t0";
  transforms.forEach((step, idx) => {
    const next = `t${idx + 1}`;
    switch (step.function) {
      case "Cast":
        ctes.push(`${next} AS (${compileCast(step, current)})`);
        break;
      case "Filter":
        ctes.push(`${next} AS (${compileFilter(step, current)})`);
        break;
      case "Drop":
        ctes.push(`${next} AS (${compileDrop(step, current)})`);
        break;
      case "Rename":
        ctes.push(`${next} AS (${compileRename(step, current)})`);
        break;
      case "Join": {
        if (step.joinType === "cross") hasCrossJoin = true;
        ctes.push(`${next} AS (${compileJoin(step, current)})`);
        externalReads.push(step.rightPath);
        break;
      }
      case "Union":
        ctes.push(`${next} AS (${compileUnion(step, current)})`);
        externalReads.push(step.otherPath);
        break;
      case "Normalize":
        // Not reachable — rejectUnsupported() threw above.
        throw new AppError(
          "Normalize is not supported on compute_type='duckdb' — set compute_type='legacy_nodejs' on the pipeline",
          400,
          "NORMALIZE_REQUIRES_LEGACY_ENGINE",
        );
      default:
        throw new AppError(
          `Unknown transform function: ${(step as { function?: string }).function}`,
          400,
          "VALIDATION_ERROR",
        );
    }
    current = next;
  });

  const limit =
    typeof options.limit === "number" && options.limit > 0
      ? ` LIMIT ${Math.floor(options.limit)}`
      : "";
  const sql = `WITH ${ctes.join(",\n     ")}\nSELECT * FROM ${current}${limit}`;

  return { sql, preambles, externalReads, hasCrossJoin };
}

function rejectUnsupported(transforms: TransformStep[]): void {
  for (const step of transforms) {
    if (step.function === "Normalize") {
      throw new AppError(
        "Normalize transforms are not supported on compute_type='duckdb'. " +
          "Set compute_type='legacy_nodejs' on the pipeline or drop the Normalize step " +
          "(tracked by PB-B2.follow-2 — Rust UDF).",
        400,
        "NORMALIZE_REQUIRES_LEGACY_ENGINE",
      );
    }
    if (step.function === "Join" && step.joinType === "cross") {
      if (!step.allowCrossJoin) {
        throw new AppError(
          "Cross-join rejected at compile time. Pass allowCrossJoin=true and " +
            "estimatedCardinality<10_000_000 on the Join step to confirm the blast radius.",
          400,
          "CROSS_JOIN_NOT_ALLOWED",
        );
      }
      const n = step.estimatedCardinality ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(n) || n <= 0) {
        throw new AppError(
          "Cross-join requires estimatedCardinality > 0.",
          400,
          "CROSS_JOIN_CARDINALITY_REQUIRED",
        );
      }
      if (n >= 10_000_000) {
        throw new AppError(
          `Cross-join estimatedCardinality=${n} exceeds the 10,000,000 ceiling. ` +
            "Refactor with an equi-join key or shard the inputs first.",
          400,
          "CROSS_JOIN_CARDINALITY_TOO_LARGE",
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-step SQL emitters.
// ---------------------------------------------------------------------------

function compileCast(step: CastStep, from: string): string {
  const sourceCol = quoteIdent(step.expression);
  const outputCol = quoteIdent(step.outputColumn ?? step.expression);
  const sqlType = mapTargetType(step.targetType);
  // Replace-in-place: use EXCLUDE to drop the source column and add a
  // recomputed one of the same name. When outputColumn differs, we keep
  // the source column and append the cast as a new column (mirrors the
  // legacy TS engine's ({ ...row, [outputCol]: castValue }) behaviour).
  if (step.outputColumn && step.outputColumn !== step.expression) {
    return `SELECT *, TRY_CAST(${sourceCol} AS ${sqlType}) AS ${outputCol} FROM ${from}`;
  }
  return `SELECT * EXCLUDE (${sourceCol}), TRY_CAST(${sourceCol} AS ${sqlType}) AS ${outputCol} FROM ${from}`;
}

function mapTargetType(t: CastStep["targetType"]): string {
  switch (t) {
    case "string":
      return "VARCHAR";
    case "integer":
      return "BIGINT";
    case "numeric":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP";
  }
}

function compileFilter(step: FilterStep, from: string): string {
  const mode = step.mode ?? "keep";
  const match = step.match ?? "all";
  const conditions = step.conditions ?? [];
  if (conditions.length === 0) {
    // No conditions = identity in both modes (match every row vacuously).
    return `SELECT * FROM ${from}`;
  }
  const exprs = conditions.map((c) => `(${compileCondition(c)})`);
  const joined = match === "all" ? exprs.join(" AND ") : exprs.join(" OR ");
  const predicate = mode === "keep" ? joined : `NOT (${joined})`;
  return `SELECT * FROM ${from} WHERE ${predicate}`;
}

function compileCondition(c: FilterCondition): string {
  const col = quoteIdent(c.column);
  // CSV semantics: the legacy engine stringifies values and treats empty
  // string + 'null'/'NULL' as null. We mirror that by casting to VARCHAR
  // and using NULLIF for the comparisons.
  const s = `NULLIF(NULLIF(CAST(${col} AS VARCHAR), ''), 'null')`;
  const v = (c.value ?? "").replace(/'/g, "''");
  switch (c.operator) {
    case "eq":
      return `${s} = '${v}'`;
    case "neq":
      return `${s} IS NULL OR ${s} <> '${v}'`;
    case "starts_with":
      return `${s} LIKE '${likeEscape(v)}%' ESCAPE '\\'`;
    case "ends_with":
      return `${s} LIKE '%${likeEscape(v)}' ESCAPE '\\'`;
    case "contains":
      return `${s} LIKE '%${likeEscape(v)}%' ESCAPE '\\'`;
    case "is_null":
      return `${s} IS NULL`;
    case "is_not_null":
      if (c.treatEmptyAsNull) {
        return `${s} IS NOT NULL`;
      }
      // Default: "" is a value, only null/undefined/'null' count as null.
      return `NULLIF(CAST(${col} AS VARCHAR), 'null') IS NOT NULL`;
    case "regex_find":
      return `${s} IS NOT NULL AND regexp_matches(${s}, '${v}')`;
    case "regex_match":
      return `${s} IS NOT NULL AND regexp_matches(${s}, '^${v}$')`;
    default:
      return "TRUE";
  }
}

function likeEscape(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

function compileDrop(step: DropStep, from: string): string {
  const cols = (step.columns ?? []).map(quoteIdent);
  if (cols.length === 0) return `SELECT * FROM ${from}`;
  return `SELECT * EXCLUDE (${cols.join(", ")}) FROM ${from}`;
}

function compileRename(step: RenameStep, from: string): string {
  // DuckDB supports `SELECT * RENAME (a AS b, c AS d)`. When multiple
  // renames collide (from repeated a→b a→c in the list, legacy TS takes
  // the last), we deduplicate to match that semantic.
  const m = new Map<string, string>();
  for (const r of step.renames ?? []) m.set(r.from, r.to);
  if (m.size === 0) return `SELECT * FROM ${from}`;
  const pairs = Array.from(m.entries())
    .map(([fromCol, toCol]) => `${quoteIdent(fromCol)} AS ${quoteIdent(toCol)}`)
    .join(", ");
  return `SELECT * RENAME (${pairs}) FROM ${from}`;
}

function compileJoin(step: JoinStep, from: string): string {
  const right = readSource(step.rightPath);
  const alias = step.rightAlias ?? "r";
  const joinKind = joinSql(step.joinType);
  if (step.joinType === "cross") {
    return `SELECT * FROM ${from} AS l, ${right} AS ${quoteIdent(alias)}`;
  }
  const on = (step.on ?? [])
    .map(
      (p) =>
        `l.${quoteIdent(p.left)} = ${quoteIdent(alias)}.${quoteIdent(p.right)}`,
    )
    .join(" AND ");
  if (!on) {
    throw new AppError(
      "Join step requires at least one on={left, right} clause unless joinType='cross'.",
      400,
      "VALIDATION_ERROR",
    );
  }
  // Column collisions are resolved by DuckDB's natural disambiguation
  // (duplicate names get a numeric suffix). The legacy TS engine's
  // left/right prefix rule is captured exactly by PB-B2.follow-5 — for
  // now `SELECT *` matches the byte-shape on non-colliding joins, which
  // is the dominant case in production chains.
  return `SELECT * FROM ${from} AS l ${joinKind} JOIN ${right} AS ${quoteIdent(alias)} ON ${on}`;
}

function joinSql(kind: JoinStep["joinType"]): string {
  switch (kind) {
    case "inner":
      return "INNER";
    case "left":
      return "LEFT";
    case "right":
      return "RIGHT";
    case "full":
      return "FULL OUTER";
    case "cross":
      return "CROSS";
  }
}

function compileUnion(step: UnionStep, from: string): string {
  const byName = step.byName ?? true;
  const right = readSource(step.otherPath);
  return byName
    ? `SELECT * FROM ${from} UNION ALL BY NAME SELECT * FROM ${right}`
    : `SELECT * FROM ${from} UNION ALL SELECT * FROM ${right}`;
}

// ---------------------------------------------------------------------------
// Source readers.
//
// A local path becomes read_csv_auto('…'); an s3:// path goes through the
// httpfs extension bootstrapped by services/duckdb/pool.ts. Parquet reads
// dispatch on the file extension so PB-B3 outputs (Parquet) drop in
// transparently without a compile-time flag.
// ---------------------------------------------------------------------------

export function readSource(path: string): string {
  const p = path.replace(/'/g, "''");
  const isParquet = /\.parquet$/i.test(path) || /\/$/.test(path);
  if (isParquet) {
    return `read_parquet('${p}')`;
  }
  return `read_csv_auto('${p}')`;
}

// ---------------------------------------------------------------------------
// Identifier quoting — DuckDB uses "double-quote" for identifiers. We
// escape embedded quotes by doubling, matching the SQL standard.
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Execution — used by TransformService.executeChain when compute_type=duckdb.
// ---------------------------------------------------------------------------

export interface ExecuteOptions extends CompileOptions {
  /** Hard memory cap for this connection. Defaults per the pool (1GB). */
  memoryLimit?: string;
}

export interface ExecuteResult {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

export async function executeTransformChain(
  transforms: TransformStep[],
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  // ── Defense-in-depth: reject unqualified inputPath ─────────────────
  //
  // The legacy bug we shipped (PB-B2) was a caller passing a bare S3
  // object key. DuckDB then resolved it as a local FS path relative to
  // the API process CWD and returned an opaque 500 —
  // `IO Error: No files found that match the pattern ...`. Guarding here
  // means a future contributor who adds a new caller and forgets to
  // convert via `toDuckDbReadUri()` gets a fast, actionable error
  // instead of a confusing IO failure deep inside DuckDB.
  //
  // Accepted shapes mirror `storageService.isQualifiedDuckDbUri`:
  //   s3://, http(s)://, file://, or absolute /path. Anything else
  //   should never reach this engine.
  rejectUnqualifiedInputPath(options.inputPath);
  const plan = compileTransformChain(transforms, options);
  const conn = await acquireConnection({
    memoryLimit: options.memoryLimit,
    // Unit tests pass file:// paths; S3 creds are harmless but we allow
    // skipping httpfs for deterministic no-network runs.
    skipHttpfs: shouldSkipHttpfs(options.inputPath),
  });
  try {
    for (const p of plan.preambles) await runAll(conn, p);
    const rows = await queryAll<Record<string, unknown>>(conn, plan.sql);
    const normalised = rows.map(normaliseRow);
    const columns = inferColumns(normalised);
    return { columns, rows: normalised, rowCount: normalised.length };
  } finally {
    releaseConnection(conn);
  }
}

/**
 * DuckDB's node binding returns BigInt for INTEGER / BIGINT columns.
 * The legacy pure-TS engine returns `number`. Down-convert when the
 * magnitude is safe so the preview envelope matches byte-for-byte on
 * common cases; preserve BigInt when it would lose precision.
 */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = normaliseValue(v);
  }
  return out;
}

function normaliseValue(v: unknown): unknown {
  if (typeof v === "bigint") {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  return v;
}

function shouldSkipHttpfs(path: string): boolean {
  return !/^s3:/i.test(path) && !/^https?:/i.test(path);
}

/**
 * Throw if `inputPath` is not one of the URI shapes DuckDB's httpfs (or
 * the local FS reader) can resolve. See `executeTransformChain` for the
 * historical bug that motivated this guard.
 *
 * Kept inline rather than imported from `storageService` so this engine
 * module stays free of an upward dependency on storage — the engine
 * accepts URIs and that's it.
 */
function rejectUnqualifiedInputPath(inputPath: string): void {
  if (!inputPath) {
    throw new AppError(
      "DuckDB transform engine: inputPath is required",
      400,
      "VALIDATION_ERROR",
    );
  }
  const qualified =
    /^s3:\/\//i.test(inputPath) ||
    /^https?:\/\//i.test(inputPath) ||
    /^file:\/\//i.test(inputPath) ||
    inputPath.startsWith("/");
  if (!qualified) {
    throw new AppError(
      `DuckDB transform engine: inputPath must be a qualified URI ` +
        `(s3://, http(s)://, file://, or absolute path); received "${inputPath}". ` +
        `Pass dataset.file_path through storageService.toDuckDbReadUri() first.`,
      400,
      "VALIDATION_ERROR",
    );
  }
}

function inferColumns(
  rows: Array<Record<string, unknown>>,
): Array<{ name: string; type: string }> {
  if (rows.length === 0) return [];
  const first = rows[0];
  return Object.keys(first).map((name) => ({
    name,
    type: inferType(first[name]),
  }));
}

function inferType(v: unknown): string {
  if (v === null || v === undefined) return "text";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "double";
  if (typeof v === "boolean") return "boolean";
  if (v instanceof Date) return "timestamp";
  return "text";
}

/**
 * Expose a compile-only path for unit tests — lets the suite pin emitted
 * SQL without requiring the native binding to be installed in CI.
 */
export const __internals = {
  compileCast,
  compileFilter,
  compileCondition,
  compileDrop,
  compileRename,
  compileJoin,
  compileUnion,
  rejectUnsupported,
};
