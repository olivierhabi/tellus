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
  | UnionStep
  | SelectStep
  | SortStep
  | DropDuplicatesStep
  | UppercaseColumnNamesStep
  | RowSizeStep
  | ApplyExpressionStep
  | CaseExpressionStep
  | ConcatenateStringsStep
  | ApplyMultipleExpressionsStep
  | ApplyToMultipleColumnsStep
  | ComputeIfExpressionAbsentStep
  | TextBlockStep
  | HashSha256Step
  | WindowStep
  | AggregateStep
  | RollupStep
  | AggregateOnConditionStep
  | TopRowsStep
  | PivotStep
  | UnpivotStep
  | KeepDuplicatesStep
  | CurrentTimestampStep;

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
    | "lt"
    | "lte"
    | "gt"
    | "gte"
    | "starts_with"
    | "ends_with"
    | "contains"
    | "is_null"
    | "is_not_null"
    | "regex_find"
    | "regex_match";
  value?: string;
  /** When true, `value` names another column (column-to-column comparison). */
  valueIsColumn?: boolean;
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
  /**
   * The PERSISTED identifier for the right-hand input. Present on stored node
   * configs (which key the join off a canvas node) but absent from the engine
   * vocabulary, which identifies the input by `rightPath`. Carried here only
   * so a shape mismatch can name the offending node instead of failing with
   * `Cannot read properties of undefined`. Resolution rightNodeId → rightPath
   * is the caller's job — see pipelines/engineBuild.toEngineSteps.
   */
  rightNodeId?: string;
  rightAlias?: string;
  joinType: "inner" | "left" | "right" | "full" | "cross" | "semi" | "anti";
  /**
   * Join conditions, combined with AND (Palantir's `and(...)` expression).
   * `operator` omitted = `equals`, which keeps every historical equality-only
   * step compiling to the same SQL. The inequality operators are the theta
   * joins the `complex*JoinV1` family expresses as `Expression<Boolean>`.
   */
  on?: Array<{
    left: string;
    right: string;
    operator?:
      | "equals"
      | "notEquals"
      | "lessThan"
      | "lessThanOrEqual"
      | "greaterThan"
      | "greaterThanOrEqual";
  }>;
  /** Required when joinType='cross'. Guard against compile-time OOMs. */
  allowCrossJoin?: boolean;
  estimatedCardinality?: number;
}
export interface UnionStep {
  function: "Union";
  /**
   * Second input (legacy two-input shape). Kept because every existing step
   * carries it; `otherPaths` is the N-input form matching Palantir's
   * `List<Table>`. Both may be present — the singular leads.
   */
  otherPath?: string;
  /** Additional inputs beyond the first, in order. */
  otherPaths?: string[];
  /** By name (default) or by position. */
  byName?: boolean;
  /**
   * Palantir schema-policy variants (PB-B2.follow-2). Omitted = legacy
   * byName/byPosition behaviour.
   *   first  — output = left's columns only (firstUnionByNameV1)
   *   narrow — output = intersection of both inputs (narrowUnionByNameV1)
   *   wide   — output = superset with null fill (wideUnionByNameV1)
   */
  mode?: "first" | "narrow" | "wide";
}

// --- Tier A single-input transforms (PB-B2.follow) -------------------------

export interface SelectStep {
  function: "Select";
  columns: string[];
}
export interface SortStep {
  function: "Sort";
  sorts: Array<{ column: string; direction: "asc" | "desc"; nulls?: "first" | "last" }>;
}
export interface DropDuplicatesStep {
  function: "DropDuplicates";
  /** When omitted/empty, dedupe on all columns. */
  columns?: string[];
}
export interface UppercaseColumnNamesStep {
  function: "UppercaseColumnNames";
}
export interface RowSizeStep {
  function: "RowSize";
  outputColumn?: string;
}
export interface OperandShape {
  kind: "column" | "literal";
  value: string;
  literalType?: "string" | "integer" | "numeric" | "boolean";
}
export type BinaryOp = "+" | "-" | "*" | "/" | "||" | "==" | "!=" | ">" | "<" | ">=" | "<=";
export interface ExpressionItemShape {
  left: OperandShape;
  operator: BinaryOp;
  right: OperandShape;
  outputColumn: string;
  outputType?: "string" | "integer" | "numeric" | "boolean" | "date" | "timestamp";
}
export interface ApplyExpressionStep {
  function: "ApplyExpression";
  expression: ExpressionItemShape;
}
export interface CaseExpressionStep {
  function: "CaseExpression";
  branches: Array<{
    condition: Omit<ExpressionItemShape, "outputColumn" | "outputType">;
    value: OperandShape;
  }>;
  defaultValue: OperandShape | null;
  outputColumn: string;
  outputType?: "string" | "integer" | "numeric" | "boolean" | "date" | "timestamp";
}
export interface ConcatenateStringsStep {
  function: "ConcatenateStrings";
  expressions: OperandShape[];
  separator: string;
  nullOutputIfAnyInputIsNull?: boolean;
  outputColumn: string;
}
export interface ApplyMultipleExpressionsStep {
  function: "ApplyMultipleExpressions";
  expressions: ExpressionItemShape[];
}
export interface ApplyToMultipleColumnsStep {
  function: "ApplyToMultipleColumns";
  columns: string[];
  operator: BinaryOp;
  right: OperandShape;
  outputSuffix?: string;
  outputColumns?: string[];
  outputType?: "string" | "integer" | "numeric" | "boolean" | "date" | "timestamp";
}
export interface ComputeIfExpressionAbsentStep {
  function: "ComputeIfExpressionAbsent";
  outputColumn: string;
  expression: Omit<ExpressionItemShape, "outputColumn">;
}
export interface TextBlockStep {
  function: "TextBlock";
  text?: string;
  title?: string;
}

/**
 * Hash sha256 — Parity: pb-functions-expression/sha256V1.
 *
 * Declared arguments (Palantir): one `Expression<Binary | String>`.
 * Output type: String. Supported in: Batch, Faster, Streaming.
 * Documented example: `null | null` — the function is NULL-PROPOGATING, so a
 * null input must yield null rather than the hash of an empty string.
 *
 * DuckDB's `sha256()` is itself null-propagating, so the only work here is
 * the Binary → String coercion (Palantir accepts binary input; DuckDB would
 * reject a BLOB argument to sha256).
 */
export interface HashSha256Step {
  function: "HashSha256";
  /** Column name or literal to hash. */
  expression: string;
  outputColumn: string;
}

/**
 * Window — Parity: pb-functions-transform/windowV1.
 *
 * Declared arguments (Palantir):
 *   - Dataset:  Table to perform aggregations on
 *   - Expressions: List<Expression<AnyType>> evaluated over the window
 *   - Window:   the grouping to operate over
 * Description: "Performs the specified aggregations on the input dataset
 * grouped by a set of columns." Supported in: Batch, Faster (NOT Streaming —
 * that is `aggregateOverWindowV2`, a different transform with trigger and
 * accumulation-mode arguments).
 *
 * Row cardinality is PRESERVED (this is an analytic aggregate, not GROUP BY):
 * every input row keeps its identity and gains one column per aggregation,
 * which is what makes `count(*) OVER (PARTITION BY …)` expressible. An empty
 * `partitionBy` is the whole-table partition, matching SQL's behaviour when
 * PARTITION BY is omitted.
 */
export interface WindowStep {
  function: "Window";
  /** PARTITION BY columns. Empty/omitted = one partition over all rows. */
  partitionBy?: string[];
  /** ORDER BY within each partition. Omitted = unordered (non-deterministic
   *  for order-sensitive aggregates, as Palantir documents). */
  orderBy?: Array<{ column: string; direction: "asc" | "desc" }>;
  /** One output column per entry; `count` without a column counts rows. */
  aggregations: Array<{
    function: AggregateFn;
    column?: string;
    outputColumn: string;
  }>;
}

// --- Tier B aggregate-family steps (PB-B2.follow-2) ------------------------

export type AggregateFn =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_distinct"
  | "stddev"
  | "variance";

export interface AggregationItemShape {
  /** Optional ONLY for `count` (COUNT(*) over the whole group). */
  column?: string;
  function: AggregateFn;
  outputColumn: string;
}

export interface AggregateStep {
  function: "Aggregate";
  groupBy?: string[];
  aggregations: AggregationItemShape[];
}

export interface RollupStep {
  function: "Rollup";
  rollupColumns?: string[];
  aggregations: AggregationItemShape[];
}

export interface AggregateOnConditionStep {
  function: "AggregateOnCondition";
  predicate: { kind: "all" | "columnHasType"; columnType?: string };
  aggregations: Array<{ function: "sum" | "avg" | "min" | "max" | "count"; suffix: string }>;
  groupBy?: string[];
}

export interface TopRowsStep {
  function: "TopRows";
  partitionBy?: string[];
  sorts?: Array<{ column: string; direction: "asc" | "desc"; nulls?: "first" | "last" }>;
  topN?: number;
}

export interface PivotStep {
  function: "Pivot";
  groupBy?: string[];
  pivotColumn: string;
  pivotValues: Array<{ value: string; alias: string }>;
  aggregations: AggregationItemShape[];
  aliasPosition?: "prefix" | "suffix";
}

export interface UnpivotStep {
  function: "Unpivot";
  columns: string[];
  nameColumn: string;
  valueColumn: string;
}

export interface KeepDuplicatesStep {
  function: "KeepDuplicates";
  /** Omit/empty = exact duplicate rows (key = every column). */
  columns?: string[];
}

/**
 * Palantir currentTimestampV1 parity: stamps every row of the chain with the
 * build time. Overwriting a column of the same name is supported so a chain
 * can replace a previously-authored constant (e.g. detection timestamps).
 * The value is captured ONCE per build execution so every row of a build
 * carries the identical build timestamp.
 */
export interface CurrentTimestampStep {
  function: "CurrentTimestamp";
  outputColumn: string;
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
      case "HashSha256":
        ctes.push(`${next} AS (${compileHashSha256(step, current)})`);
        break;
      case "Window":
        ctes.push(`${next} AS (${compileWindow(step, current)})`);
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
        externalReads.push(...unionOtherPaths(step));
        break;
      case "Select":
        ctes.push(`${next} AS (${compileSelect(step, current)})`);
        break;
      case "Sort":
        ctes.push(`${next} AS (${compileSort(step, current)})`);
        break;
      case "DropDuplicates":
        ctes.push(`${next} AS (${compileDropDuplicates(step, current)})`);
        break;
      case "ApplyExpression":
      case "ApplyMultipleExpressions": {
        const all = step.function === "ApplyExpression" ? [step.expression] : step.expressions;
        ctes.push(`${next} AS (${compileExpressions(all, current)})`);
        break;
      }
      case "CaseExpression":
        ctes.push(`${next} AS (${compileCaseExpression(step, current)})`);
        break;
      case "ConcatenateStrings":
        ctes.push(`${next} AS (${compileConcatenateStrings(step, current)})`);
        break;
      case "ApplyToMultipleColumns":
        ctes.push(`${next} AS (${compileApplyToMultipleColumns(step, current)})`);
        break;
      case "ComputeIfExpressionAbsent":
        ctes.push(`${next} AS (${compileComputeIfAbsent(step, current)})`);
        break;
      case "TextBlock":
        // Pure annotation — identity pass-through.
        ctes.push(`${next} AS (SELECT * FROM ${current})`);
        break;
      case "CurrentTimestamp":
        ctes.push(
          `${next} AS (${compileCurrentTimestamp(step, current, options.sourceColumns)})`,
        );
        break;
      // --- Tier B aggregate-family (PB-B2.follow-2) ---
      case "Aggregate":
        ctes.push(`${next} AS (${compileAggregate(step, current)})`);
        break;
      case "Rollup":
        ctes.push(`${next} AS (${compileRollup(step, current)})`);
        break;
      case "AggregateOnCondition":
        ctes.push(
          `${next} AS (${compileAggregateOnCondition(step, current, options.sourceColumns)})`,
        );
        break;
      case "TopRows":
        ctes.push(`${next} AS (${compileTopRows(step, current)})`);
        break;
      case "Pivot":
        ctes.push(`${next} AS (${compilePivot(step, current)})`);
        break;
      case "Unpivot":
        ctes.push(`${next} AS (${compileUnpivot(step, current)})`);
        break;
      case "KeepDuplicates":
        ctes.push(`${next} AS (${compileKeepDuplicates(step, current)})`);
        break;
      case "UppercaseColumnNames":
      case "RowSize":
      case "Normalize":
        // Not reachable — rejectUnsupported() threw above.
        throw new AppError(
          `${step.function} is not supported on compute_type='duckdb' — set compute_type='legacy_nodejs' on the pipeline`,
          400,
          step.function === "Normalize"
            ? "NORMALIZE_REQUIRES_LEGACY_ENGINE"
            : step.function === "UppercaseColumnNames"
            ? "UPPERCASE_REQUIRES_LEGACY_ENGINE"
            : "ROWSIZE_REQUIRES_LEGACY_ENGINE",
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
    if (step.function === "UppercaseColumnNames") {
      throw new AppError(
        "UppercaseColumnNames is not supported on compute_type='duckdb' (column-name fold needs the legacy TS engine). " +
          "Set compute_type='legacy_nodejs' on the pipeline.",
        400,
        "UPPERCASE_REQUIRES_LEGACY_ENGINE",
      );
    }
    if (step.function === "RowSize") {
      throw new AppError(
        "RowSize is not supported on compute_type='duckdb' (no portable whole-row byte-size SQL). " +
          "Set compute_type='legacy_nodejs' on the pipeline.",
        400,
        "ROWSIZE_REQUIRES_LEGACY_ENGINE",
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

// Regex that splits a slash/dash/dot-separated date into its three fields.
// Applied after separators are normalised to '/', so only '/' appears here.
const DATE_PARTS_RE = "'^([0-9]{1,2})/([0-9]{1,2})/([0-9]{2}|[0-9]{4})$'";

/**
 * SQL that decides whether a column of separator-dates is month-first or
 * day-first, by counting values that can only be read one way. Emits 1 for
 * month-first, 0 for day-first (which is also the no-evidence default).
 *
 * This is the SQL twin of inferDateFormat() in utils/typeConverter.ts, and the
 * two must stay in agreement: the same chain can run through either engine
 * depending on pipelines.compute_type, and a preview that disagrees with the
 * materialised output is worse than either answer alone.
 */
function dateOrderProbe(col: string, from: string): string {
  const norm = `regexp_replace(trim(CAST(${col} AS VARCHAR)), '[-.]', '/', 'g')`;
  return `(SELECT CASE WHEN
      SUM(CASE WHEN __p2 > 12 AND __p1 <= 12 THEN 1 ELSE 0 END) >
      SUM(CASE WHEN __p1 > 12 AND __p2 <= 12 THEN 1 ELSE 0 END)
    THEN 1 ELSE 0 END
    FROM (SELECT TRY_CAST(regexp_extract(__n, ${DATE_PARTS_RE}, 1) AS INTEGER) AS __p1,
                 TRY_CAST(regexp_extract(__n, ${DATE_PARTS_RE}, 2) AS INTEGER) AS __p2
          FROM (SELECT ${norm} AS __n FROM ${from})))`;
}

/**
 * Parse a date/timestamp column by dispatching on the value's *shape* before
 * falling back to TRY_CAST.
 *
 * Shape dispatch has to come first: TRY_CAST('30/7/23' AS DATE) does not fail,
 * it silently returns year 0030. Only after the separator shapes are handled is
 * TRY_CAST safe to use for ISO and other native forms.
 *
 * `order` picks the two-field interpretation for values that are ambiguous
 * ('7/6/23'); values that can only be read one way parse correctly either way.
 */
function parseDateShaped(
  col: string,
  order: "dmy" | "mdy",
  sqlType: string,
): string {
  const s = `nullif(trim(CAST(${col} AS VARCHAR)), '')`;
  const n = `regexp_replace(${s}, '[-.]', '/', 'g')`;
  const f2 = order === "mdy" ? "'%m/%d/%y'" : "'%d/%m/%y'";
  const f4 = order === "mdy" ? "'%m/%d/%Y'" : "'%d/%m/%Y'";
  return `CASE
    WHEN ${s} IS NULL THEN NULL
    WHEN regexp_matches(${n}, '^[0-9]{4}/[0-9]{1,2}/[0-9]{1,2}$')
      THEN CAST(TRY_STRPTIME(${n}, '%Y/%m/%d') AS ${sqlType})
    WHEN regexp_matches(${n}, '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$')
      THEN CAST(TRY_STRPTIME(${n}, ${f4}) AS ${sqlType})
    WHEN regexp_matches(${n}, '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$')
      THEN CAST(TRY_STRPTIME(${n}, ${f2}) AS ${sqlType})
    ELSE COALESCE(
      TRY_CAST(${s} AS ${sqlType}),
      CAST(TRY_STRPTIME(${s}, ['%d-%b-%Y','%d %b %Y','%b %d %Y','%b %d, %Y']) AS ${sqlType}))
  END`;
}

/**
 * The cast expression for one column. Date and timestamp targets get the
 * shape-dispatched parser with per-column day/month inference; every other
 * target is a plain lenient TRY_CAST.
 */
function castExpr(
  col: string,
  targetType: CastStep["targetType"],
  from: string,
): string {
  const sqlType = mapTargetType(targetType);
  if (targetType !== "date" && targetType !== "timestamp") {
    return `TRY_CAST(${col} AS ${sqlType})`;
  }
  return `CASE WHEN ${dateOrderProbe(col, from)} = 1
    THEN ${parseDateShaped(col, "mdy", sqlType)}
    ELSE ${parseDateShaped(col, "dmy", sqlType)} END`;
}

function compileCast(step: CastStep, from: string): string {
  const sourceCol = quoteIdent(step.expression);
  const outputCol = quoteIdent(step.outputColumn ?? step.expression);
  const expr = castExpr(sourceCol, step.targetType, from);
  // Replace-in-place: use EXCLUDE to drop the source column and add a
  // recomputed one of the same name. When outputColumn differs, we keep
  // the source column and append the cast as a new column (mirrors the
  // legacy TS engine's ({ ...row, [outputCol]: castValue }) behaviour).
  if (step.outputColumn && step.outputColumn !== step.expression) {
    return `SELECT *, ${expr} AS ${outputCol} FROM ${from}`;
  }
  return `SELECT * EXCLUDE (${sourceCol}), ${expr} AS ${outputCol} FROM ${from}`;
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

const FILTER_ORD_SQL: Record<string, string> = {
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

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
  // Right-hand operand: literal by default, column reference when the
  // condition compares column-to-column (valueIsColumn).
  const rhs = c.valueIsColumn
    ? `CAST(${quoteIdent(c.value ?? "")} AS VARCHAR)`
    : `'${v}'`;
  switch (c.operator) {
    case "eq":
      return `${s} = ${rhs}`;
    case "neq":
      return `${s} IS NULL OR ${s} <> ${rhs}`;
    // Ordering comparators (Palantir filterV1 parity with the legacy TS
    // engine's compareOrd): numerics compare numerically, everything else
    // lexicographically (ISO dates/timestamps then sort chronologically);
    // a null on EITHER side is false ("nulls are treated as false").
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (!c.valueIsColumn && (v === "" || v.toLowerCase() === "null")) {
        return "FALSE";
      }
      const sOrd = s;
      const rhsOrd = c.valueIsColumn
        ? `NULLIF(NULLIF(CAST(${quoteIdent(c.value ?? "")} AS VARCHAR), ''), 'null')`
        : `'${v}'`;
      const sqlOp = FILTER_ORD_SQL[c.operator];
      return (
        `${sOrd} IS NOT NULL AND ${rhsOrd} IS NOT NULL AND ` +
        `CASE WHEN TRY_CAST(${sOrd} AS DOUBLE) IS NOT NULL AND TRY_CAST(${rhsOrd} AS DOUBLE) IS NOT NULL ` +
        `THEN TRY_CAST(${sOrd} AS DOUBLE) ${sqlOp} TRY_CAST(${rhsOrd} AS DOUBLE) ` +
        `ELSE ${sOrd} ${sqlOp} ${rhsOrd} END`
      );
    }
    case "starts_with":
      return c.valueIsColumn
        ? `${s} IS NOT NULL AND starts_with(${s}, ${rhs})`
        : `${s} LIKE '${likeEscape(v)}%' ESCAPE '\\'`;
    case "ends_with":
      return c.valueIsColumn
        ? `${s} IS NOT NULL AND ends_with(${s}, ${rhs})`
        : `${s} LIKE '%${likeEscape(v)}' ESCAPE '\\'`;
    case "contains":
      return c.valueIsColumn
        ? `${s} IS NOT NULL AND contains(${s}, ${rhs})`
        : `${s} LIKE '%${likeEscape(v)}%' ESCAPE '\\'`;
    case "is_null":
      return `${s} IS NULL`;
    case "is_not_null":
      if (c.treatEmptyAsNull) {
        return `${s} IS NOT NULL`;
      }
      // Default: "" is a value, only null/undefined/'null' count as null.
      return `NULLIF(CAST(${col} AS VARCHAR), 'null') IS NOT NULL`;
    case "regex_find":
      return `${s} IS NOT NULL AND regexp_matches(${s}, ${rhs})`;
    case "regex_match":
      return `${s} IS NOT NULL AND regexp_matches(${s}, '^' || ${rhs} || '$')`;
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
  const right = readSource(
    step.rightPath,
    step.rightNodeId
      ? `join references node ${String(step.rightNodeId).slice(0, 8)}`
      : undefined,
  );
  const alias = step.rightAlias ?? "r";
  const joinKind = joinSql(step.joinType);
  if (step.joinType === "cross") {
    return `SELECT * FROM ${from} AS l, ${right} AS ${quoteIdent(alias)}`;
  }
  const on = (step.on ?? [])
    .map(
      (p) =>
        `l.${quoteIdent(p.left)} ${joinOperatorSql(p.operator)} ` +
        `${quoteIdent(alias)}.${quoteIdent(p.right)}`,
    )
    .join(" AND ");
  if (!on) {
    throw new AppError(
      "Join step requires at least one on={left, right} clause unless joinType='cross'.",
      400,
      "VALIDATION_ERROR",
    );
  }
  // Semi / anti joins return LEFT columns only (Palantir
  // complexSemiJoinV1 / complexAntiJoinV1). DuckDB's SEMI/ANTI syntax
  // does exactly this: `SELECT l.* FROM l SEMI JOIN r ON …`.
  if (step.joinType === "semi" || step.joinType === "anti") {
    const kw = step.joinType === "semi" ? "SEMI" : "ANTI";
    return `SELECT l.* FROM ${from} AS l ${kw} JOIN ${right} AS ${quoteIdent(alias)} ON ${on}`;
  }
  // Column collisions are resolved by DuckDB's natural disambiguation
  // (duplicate names get a numeric suffix). The legacy TS engine's
  // left/right prefix rule is captured exactly by PB-B2.follow-5 — for
  // now `SELECT *` matches the byte-shape on non-colliding joins, which
  // is the dominant case in production chains.
  return `SELECT * FROM ${from} AS l ${joinKind} JOIN ${right} AS ${quoteIdent(alias)} ON ${on}`;
}

/**
 * SQL comparison for one join condition. Emitted from a closed switch rather
 * than interpolated from the payload, so an unexpected operator string cannot
 * reach the SQL text.
 *
 * SQL's `=` and `<>` already treat NULL as unknown (never matching), which is
 * the null ≠ null rule the legacy engine implements explicitly.
 */
export function joinOperatorSql(
  op: NonNullable<JoinStep["on"]>[number]["operator"],
): string {
  switch (op) {
    case undefined:
    case "equals":
      return "=";
    case "notEquals":
      return "<>";
    case "lessThan":
      return "<";
    case "lessThanOrEqual":
      return "<=";
    case "greaterThan":
      return ">";
    case "greaterThanOrEqual":
      return ">=";
    default:
      throw new AppError(
        `Unsupported join condition operator "${String(op)}".`,
        400,
        "VALIDATION_ERROR",
      );
  }
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
    case "semi":
      return "SEMI";
    case "anti":
      return "ANTI";
  }
}

/**
 * Every input after the first, de-duplicated and in order. De-duplication
 * matters because a repeated path would silently double those rows.
 */
export function unionOtherPaths(step: UnionStep): string[] {
  const ordered = [
    ...(step.otherPath ? [step.otherPath] : []),
    ...(step.otherPaths ?? []),
  ];
  return [...new Set(ordered)];
}

function compileUnion(step: UnionStep, from: string): string {
  const otherPaths = unionOtherPaths(step);
  if (otherPaths.length === 0) {
    throw new AppError(
      "Union requires at least one additional input (otherPaths, or the legacy otherPath).",
      400,
      "VALIDATION_ERROR",
    );
  }

  // Palantir schema-policy variants (PB-B2.follow-2).
  //  - `wide` is exactly DuckDB's UNION ALL BY NAME (superset, null-fill).
  //  - `first` / `narrow` need the static column algebra of BOTH inputs at
  //    compile time; this compiler doesn't track columns through chained
  //    steps, so — mirroring the Normalize/RowSize precedent — they are
  //    executed by the legacy TS engine and rejected here.
  // N inputs chain as one flat UNION ALL — associative, so a three-way union
  // is a single node rather than two chained ones (Palantir `List<Table>`).
  const tails = otherPaths.map((p) => `SELECT * FROM ${readSource(p)}`);

  if (step.mode === "wide") {
    return [`SELECT * FROM ${from}`, ...tails].join(" UNION ALL BY NAME ");
  }
  if (step.mode === "first" || step.mode === "narrow") {
    throw new AppError(
      `Union mode '${step.mode}' requires static column knowledge of both inputs. ` +
        "Set compute_type='legacy_nodejs' on the pipeline (mirrors the Normalize/RowSize precedent).",
      400,
      "UNION_MODE_REQUIRES_LEGACY_ENGINE",
    );
  }

  const byName = step.byName ?? true;
  return [`SELECT * FROM ${from}`, ...tails].join(
    byName ? " UNION ALL BY NAME " : " UNION ALL ",
  );
}

// ---------------------------------------------------------------------------
// Tier A simple-single-input emitters.
// ---------------------------------------------------------------------------

function compileSelect(step: SelectStep, from: string): string {
  const cols = (step.columns ?? []).map(quoteIdent);
  if (cols.length === 0) {
    throw new AppError(
      "Select requires at least one column.",
      400,
      "VALIDATION_ERROR",
    );
  }
  return `SELECT ${cols.join(", ")} FROM ${from}`;
}

function compileSort(step: SortStep, from: string): string {
  const keys = (step.sorts ?? []).map((s) => {
    const col = quoteIdent(s.column);
    const dir = s.direction === "desc" ? "DESC" : "ASC";
    // DuckDB defaults NULLS FIRST for ASC, NULLS LAST for DESC. We mirror
    // the legacy TS engine's convention: NULLS LAST for ASC, NULLS FIRST
    // for DESC unless explicitly overridden.
    const nulls =
      s.nulls === "first"
        ? "NULLS FIRST"
        : s.nulls === "last"
        ? "NULLS LAST"
        : s.direction === "desc"
        ? "NULLS FIRST"
        : "NULLS LAST";
    return `${col} ${dir} ${nulls}`;
  });
  if (keys.length === 0) return `SELECT * FROM ${from}`;
  return `SELECT * FROM ${from} ORDER BY ${keys.join(", ")}`;
}

function compileDropDuplicates(step: DropDuplicatesStep, from: string): string {
  const cols = (step.columns ?? []).map(quoteIdent);
  if (cols.length === 0) {
    // DISTINCT on the whole row.
    return `SELECT DISTINCT * FROM ${from}`;
  }
  // DuckDB 0.8+ supports DISTINCT ON (cols) — first occurrence wins.
  return `SELECT DISTINCT ON (${cols.join(", ")}) * FROM ${from}`;
}

/**
 * Render an operand to a SQL expression. `kind='literal'` parses the value
 * according to `literalType` (default string) and emits a quoted literal;
 * `kind='column'` emits a quoted identifier.
 */
function renderOperand(op: OperandShape): string {
  if (op.kind === "column") return quoteIdent(op.value);
  // literal
  const t = op.literalType ?? "string";
  const v = op.value ?? "";
  switch (t) {
    case "integer":
    case "numeric": {
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : "NULL";
    }
    case "boolean":
      return v === "true" ? "TRUE" : "FALSE";
    case "string":
    default: {
      const esc = v.replace(/'/g, "''");
      return `'${esc}'`;
    }
  }
}

/** Equality is null-safe, matching Pipeline Builder's "is equal to". */
function sqlOp(op: BinaryOp): string {
  switch (op) {
    case "==":
      return "IS NOT DISTINCT FROM";
    case "!=":
      return "IS DISTINCT FROM";
    default:
      return op;
  }
}

function renderExpression(e: ExpressionItemShape): string {
  return `(${renderOperand(e.left)} ${sqlOp(e.operator)} ${renderOperand(e.right)})`;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderConcatenateStringsExpression(step: ConcatenateStringsStep): string {
  const operands = step.expressions.map((operand) => `CAST(${renderOperand(operand)} AS VARCHAR)`);
  const joined = `concat_ws(${quoteSqlString(step.separator ?? "")}, ${operands.join(", ")})`;
  if (!step.nullOutputIfAnyInputIsNull) return joined;
  return `CASE WHEN ${operands.map((operand) => `${operand} IS NULL`).join(" OR ")} THEN NULL ELSE ${joined} END`;
}

function compileConcatenateStrings(step: ConcatenateStringsStep, from: string): string {
  return `SELECT *, ${renderConcatenateStringsExpression(step)} AS ${quoteIdent(step.outputColumn)} FROM ${from}`;
}

/**
 * currentTimestampV1 parity. One `CURRENT_TIMESTAMP(6)` reference per chain
 * step — DuckDB evaluates it once per statement, so every row of a build
 * shares the build-start timestamp. Overwrites an existing input column via
 * `* REPLACE` when the source schema already carries the name; a collision
 * with a column produced by an EARLIER step of the same chain is a DuckDB
 * duplicate-alias error by design (author must not stamp twice).
 */
function compileCurrentTimestamp(
  step: CurrentTimestampStep,
  from: string,
  sourceColumns?: string[],
): string {
  const col = quoteIdent(step.outputColumn);
  if (sourceColumns?.includes(step.outputColumn)) {
    return `SELECT * REPLACE (CURRENT_TIMESTAMP(6) AS ${col}) FROM ${from}`;
  }
  return `SELECT *, CURRENT_TIMESTAMP(6) AS ${col} FROM ${from}`;
}

function castForResult(
  expr: string,
  outputType: ExpressionItemShape["outputType"],
): string {
  if (outputType === undefined) return expr;
  const sqlType = mapTargetType(outputType);
  if (outputType !== "date" && outputType !== "timestamp") {
    return `TRY_CAST(${expr} AS ${sqlType})`;
  }
  // An expression result has no column to sniff for day/month order, so use
  // the same "dmy" default that convertValue applies in the TS engine's
  // castExpressionResult. Shape dispatch still matters: TRY_CAST alone reads
  // '30/7/23' as year 0030 instead of failing.
  return parseDateShaped(expr, "dmy", sqlType);
}

function compileExpressions(
  exprs: ExpressionItemShape[],
  from: string,
): string {
  // Build the projection: keep all existing columns, then add each
  // expression's output column via the * EXCLUDE/REPLACE pattern. We use
  // a single SELECT with the existing columns plus the computed ones;
  // when an output column matches an existing column, REPLACE is used.
  if (exprs.length === 0) return `SELECT * FROM ${from}`;
  const computedParts = exprs.map((e) =>
    `${castForResult(renderExpression(e), e.outputType)} AS ${quoteIdent(e.outputColumn)}`,
  );
  // Use a simple SELECT *, <computed> FROM. When the output column already
  // exists, DuckDB will error on the duplicate alias; we mirror the legacy
  // TS engine by treating computed columns as new (overwrite) — use the
  // `* REPLACE (...)` clause to overwrite existing columns of the same
  // name. To keep this simple, we always emit `SELECT *, computed` and
  // trust the user to pick non-conflicting output column names. Edge case
  // collisions will surface a DuckDB error at runtime.
  return `SELECT *, ${computedParts.join(", ")} FROM ${from}`;
}

function renderOperandValue(operand: OperandShape | null): string {
  if (operand === null) return "NULL";
  return renderOperand(operand);
}

function compileCaseExpression(step: CaseExpressionStep, from: string): string {
  const branches = step.branches
    .map((branch) => `WHEN ${renderExpression({ ...branch.condition, outputColumn: "_case" })} THEN ${renderOperandValue(branch.value)}`)
    .join(" ");
  const expression = `CASE ${branches} ELSE ${renderOperandValue(step.defaultValue)} END`;
  return `SELECT *, ${castForResult(expression, step.outputType)} AS ${quoteIdent(step.outputColumn)} FROM ${from}`;
}

function compileApplyToMultipleColumns(
  step: ApplyToMultipleColumnsStep,
  from: string,
): string {
  const cols = step.columns ?? [];
  if (cols.length === 0) return `SELECT * FROM ${from}`;
  const suffix = step.outputSuffix ?? "_calc";
  const outNames =
    step.outputColumns ?? cols.map((c) => `${c}${suffix}`);
  const parts = cols.map((c, i) => {
    const expr: ExpressionItemShape = {
      left: { kind: "column", value: c },
      operator: step.operator,
      right: step.right,
      outputColumn: outNames[i],
      outputType: step.outputType,
    };
    return `${castForResult(renderExpression(expr), step.outputType)} AS ${quoteIdent(outNames[i])}`;
  });
  return `SELECT *, ${parts.join(", ")} FROM ${from}`;
}

function compileComputeIfAbsent(
  step: ComputeIfExpressionAbsentStep,
  from: string,
): string {
  // When the output column is absent/null/empty, replace it with the
  // expression. CSV null-ish values map to: IS NULL OR '' OR 'null'/'NULL'.
  const outCol = quoteIdent(step.outputColumn);
  const expr = renderExpression(step.expression as ExpressionItemShape);
  const coalesced = `COALESCE(${outCol}, ${castForResult(expr, (step.expression as { outputType?: string }).outputType as ExpressionItemShape["outputType"])})`;
  // Use REPLACE so the column keeps its position when it already exists.
  return `SELECT * REPLACE (${coalesced} AS ${outCol}) FROM ${from}`;
}

// ---------------------------------------------------------------------------
// Tier B aggregate-family emitters (PB-B2.follow-2).
// Palantir refs: aggregateV1, rollUpV1, aggregateOnConditionV1, topRowV2,
// pivotV1, unpivotV1, keepDuplicatesV1.
// ---------------------------------------------------------------------------

/**
 * Hash sha256 — `sha256V1` parity.
 *
 * Palantir declares one `Expression<Binary | String>` argument and a String
 * output, with the documented example `null -> null`. DuckDB's `sha256()` is
 * already null-propagating; the explicit CAST covers the Binary half of the
 * declared type, which DuckDB's sha256 would not accept as a BLOB.
 * A source column of the same name is replaced in place (`* REPLACE`),
 * matching compileCast / compileCurrentTimestamp.
 */
function compileHashSha256(step: HashSha256Step, from: string): string {
  const out = quoteIdent(step.outputColumn);
  const expr = `sha256(CAST(${quoteIdent(step.expression)} AS VARCHAR))`;
  if (step.outputColumn === step.expression) {
    return `SELECT * REPLACE (${expr} AS ${out}) FROM ${from}`;
  }
  return `SELECT *, ${expr} AS ${out} FROM ${from}`;
}

/**
 * Window — `windowV1` parity.
 *
 * Each aggregation becomes an analytic aggregate over the partition, so row
 * cardinality is preserved: `COUNT(*) OVER (PARTITION BY a, b) AS n` is the
 * per-key row count attached to every row of that key, which is what makes
 * `count(*) over (partition by step, amount_key)` expressible as one step.
 *
 * An unordered window (no `orderBy`) matches Palantir's documented caveat for
 * window aggregates without ordering: only order-INSENSITIVE aggregates
 * (count / sum / min / max) are deterministic, and an order-sensitive one
 * (row-number-like) has no meaning without an ORDER BY. `aggregateSql` can
 * only emit the order-insensitive family, so that holds structurally.
 */
function compileWindow(step: WindowStep, from: string): string {
  const parts: string[] = [];
  const partition = (step.partitionBy ?? []).map(quoteIdent);
  if (partition.length > 0) parts.push(`PARTITION BY ${partition.join(", ")}`);
  const order = (step.orderBy ?? []).map(
    (o) => `${quoteIdent(o.column)} ${o.direction === "desc" ? "DESC" : "ASC"}`,
  );
  if (order.length > 0) parts.push(`ORDER BY ${order.join(", ")}`);
  const over = parts.length > 0 ? ` OVER (${parts.join(" ")})` : " OVER ()";
  const aggs = step.aggregations.map(
    (a) => `${aggregateSql(a as AggregationItemShape)}${over} AS ${quoteIdent(a.outputColumn)}`,
  );
  if (aggs.length === 0) {
    // windowV1 declares Expressions as a non-empty list, so an empty one is a
    // malformed step, not a pass-through.
    throw new AppError(
      "Window requires at least one aggregation (windowV1 declares a non-empty Expressions list)",
      400,
      "VALIDATION_ERROR",
    );
  }
  return `SELECT *, ${aggs.join(", ")} FROM ${from}`;
}

/** Map an aggregation spec to its DuckDB aggregate expression. */
function aggregateSql(a: AggregationItemShape): string {
  const col = a.column ? quoteIdent(a.column) : null;
  switch (a.function) {
    case "count":
      // count(col) = non-null count; bare count = COUNT(*).
      return col ? `COUNT(${col})` : "COUNT(*)";
    case "count_distinct":
      return `COUNT(DISTINCT ${col})`;
    case "sum":
      return `SUM(${col})`;
    case "avg":
      return `AVG(${col})`;
    case "min":
      return `MIN(${col})`;
    case "max":
      return `MAX(${col})`;
    case "stddev":
      return `STDDEV_SAMP(${col})`;
    case "variance":
      return `VAR_SAMP(${col})`;
  }
}

function compileAggregate(step: AggregateStep, from: string): string {
  const groups = (step.groupBy ?? []).map(quoteIdent);
  const aggs = step.aggregations.map(
    (a) => `${aggregateSql(a)} AS ${quoteIdent(a.outputColumn)}`,
  );
  const select = [...groups, ...aggs].join(", ");
  return groups.length > 0
    ? `SELECT ${select} FROM ${from} GROUP BY ${groups.join(", ")}`
    : `SELECT ${select} FROM ${from}`;
}

function compileRollup(step: RollupStep, from: string): string {
  // DuckDB: GROUP BY ROLLUP(a, b) → (a,b), (a), () super-aggregates with
  // NULL placeholders — mirrors Palantir rollUpV1's super-aggregate rows.
  const cols = (step.rollupColumns ?? []).map(quoteIdent);
  const aggs = step.aggregations.map(
    (a) => `${aggregateSql(a)} AS ${quoteIdent(a.outputColumn)}`,
  );
  if (cols.length === 0) {
    // Palantir rollUpV1 example 5: empty rollup = single global row.
    return `SELECT ${aggs.join(", ")} FROM ${from}`;
  }
  return `SELECT ${[...cols, ...aggs].join(", ")} FROM ${from} GROUP BY ROLLUP(${cols.join(", ")})`;
}

function compileAggregateOnCondition(
  step: AggregateOnConditionStep,
  from: string,
  sourceColumns?: string[],
): string {
  // The column predicate ('all' | columnHasType) is resolved against the
  // source schema; per matching column each expression becomes
  //   <fn>(col) AS <col><suffix>   (Palantir columnNameConcat alias).
  const pred = step.predicate;
  let targets: string[];
  if (pred.kind === "all") {
    targets = sourceColumns ?? [];
  } else {
    // Column-type predicates need schema types — the chain compiler only
    // carries column NAMES, so type predicates are a legacy-engine path.
    throw new AppError(
      "AggregateOnCondition with a column-type predicate requires schema type " +
        "knowledge at compile time. Set compute_type='legacy_nodejs' on the pipeline.",
      400,
      "AOC_REQUIRES_LEGACY_ENGINE",
    );
  }
  if (targets.length === 0) {
    throw new AppError(
      "AggregateOnCondition: no columns matched the predicate (source column list missing?).",
      400,
      "VALIDATION_ERROR",
    );
  }
  const groups = (step.groupBy ?? []).map(quoteIdent);
  const aggs: string[] = [];
  for (const col of targets) {
    for (const expr of step.aggregations) {
      const item: AggregationItemShape = {
        column: col,
        function: expr.function,
        outputColumn: `${col}${expr.suffix}`,
      };
      aggs.push(`${aggregateSql(item)} AS ${quoteIdent(item.outputColumn)}`);
    }
  }
  const select = [...groups, ...aggs].join(", ");
  return groups.length > 0
    ? `SELECT ${select} FROM ${from} GROUP BY ${groups.join(", ")}`
    : `SELECT ${select} FROM ${from}`;
}

function compileTopRows(step: TopRowsStep, from: string): string {
  // topRowV2: ROW_NUMBER() over (PARTITION BY p ORDER BY sorts) <= topN.
  const partitions = (step.partitionBy ?? []).map(quoteIdent);
  const order = (step.sorts ?? []).map((s) => {
    const dir = s.direction === "desc" ? "DESC" : "ASC";
    const nulls =
      s.nulls === "first"
        ? "NULLS FIRST"
        : s.nulls === "last"
        ? "NULLS LAST"
        : s.direction === "desc"
        ? "NULLS FIRST"
        : "NULLS LAST";
    return `${quoteIdent(s.column)} ${dir} ${nulls}`;
  });
  const n = Math.max(1, Math.floor(step.topN ?? 1));
  const overParts: string[] = [];
  if (partitions.length > 0) overParts.push(`PARTITION BY ${partitions.join(", ")}`);
  if (order.length > 0) overParts.push(`ORDER BY ${order.join(", ")}`);
  return (
    `SELECT * EXCLUDE (__top_rows_rn) FROM (` +
    `SELECT *, ROW_NUMBER() OVER (${overParts.join(" ")}) AS __top_rows_rn FROM ${from}` +
    `) WHERE __top_rows_rn <= ${n}`
  );
}

function compilePivot(step: PivotStep, from: string): string {
  // pivotV1: per (pivot-value × aggregation) a filtered-aggregate column:
  //   AVG(CASE WHEN pcol = 'JFK' THEN miles END) AS new_york_miles
  const groups = (step.groupBy ?? []).map(quoteIdent);
  const position = step.aliasPosition ?? "prefix";
  const cols: string[] = [];
  for (const pv of step.pivotValues) {
    for (const agg of step.aggregations) {
      if (!agg.column) {
        throw new AppError(
          "Pivot aggregations require a column (count(*) pivot is not supported).",
          400,
          "VALIDATION_ERROR",
        );
      }
      const name =
        position === "prefix"
          ? `${pv.alias}_${agg.outputColumn}`
          : `${agg.outputColumn}_${pv.alias}`;
      const v = pv.value.replace(/'/g, "''");
      const filtered = {
        ...agg,
        column: `CASE WHEN CAST(${quoteIdent(step.pivotColumn)} AS VARCHAR) = '${v}' THEN ${quoteIdent(agg.column)} END`,
      };
      // The CASE expression must not be re-quoted — emit raw.
      const expr = aggregateSqlRaw(filtered);
      cols.push(`${expr} AS ${quoteIdent(name)}`);
    }
  }
  return groups.length > 0
    ? `SELECT ${[...groups, ...cols].join(", ")} FROM ${from} GROUP BY ${groups.join(", ")}`
    : `SELECT ${cols.join(", ")} FROM ${from}`;
}

/** Like aggregateSql but trusts `column` to be a raw SQL expression (no quoting). */
function aggregateSqlRaw(a: AggregationItemShape): string {
  const col = a.column ?? "";
  switch (a.function) {
    case "count":
      return a.column ? `COUNT(${col})` : "COUNT(*)";
    case "count_distinct":
      return `COUNT(DISTINCT ${col})`;
    case "sum":
      return `SUM(${col})`;
    case "avg":
      return `AVG(${col})`;
    case "min":
      return `MIN(${col})`;
    case "max":
      return `MAX(${col})`;
    case "stddev":
      return `STDDEV_SAMP(${col})`;
    case "variance":
      return `VAR_SAMP(${col})`;
  }
}

function compileUnpivot(step: UnpivotStep, from: string): string {
  // unpivotV1: wide → long. Each unpivoted column becomes a row branch
  // labelled with the original column name; all other columns are kept
  // (Palantir keeps NULLs — unpivotV1 example 1). UNION ALL BY NAME
  // preserves nulls across branches.
  const name = quoteIdent(step.nameColumn);
  const value = quoteIdent(step.valueColumn);
  const allUnpivoted = step.columns.map(quoteIdent).join(", ");
  const branches = step.columns.map((c) => {
    const escaped = c.replace(/'/g, "''");
    return (
      `SELECT '${escaped}' AS ${name}, ${quoteIdent(c)} AS ${value}, ` +
      `* EXCLUDE (${allUnpivoted}) FROM ${from}`
    );
  });
  return branches.join("\nUNION ALL BY NAME\n");
}

function compileKeepDuplicates(step: KeepDuplicatesStep, from: string): string {
  // keepDuplicatesV1: rows whose key occurs more than once. Empty subset =
  // whole-row key (exact duplicates) — partition over ALL columns via a
  // positional projection is not stable in SQL, so the empty-subset case
  // uses COUNT(*) OVER (PARTITION BY <every column>). The chain compiler
  // doesn't know upstream column names; use the legacy TS engine there.
  const cols = (step.columns ?? []).map(quoteIdent);
  if (cols.length === 0) {
    throw new AppError(
      "KeepDuplicates with an empty column subset (exact-duplicate mode) requires " +
        "compile-time knowledge of all column names. Set compute_type='legacy_nodejs' " +
        "or pass an explicit column subset.",
      400,
      "VALIDATION_ERROR",
    );
  }
  return (
    `SELECT * EXCLUDE (__keep_dups_n) FROM (` +
    `SELECT *, COUNT(*) OVER (PARTITION BY ${cols.join(", ")}) AS __keep_dups_n FROM ${from}` +
    `) WHERE __keep_dups_n > 1`
  );
}

// ---------------------------------------------------------------------------
// Source readers.
//
// A local path becomes read_csv_auto('…'); an s3:// path goes through the
// httpfs extension bootstrapped by services/duckdb/pool.ts. Parquet reads
// dispatch on the file extension so PB-B3 outputs (Parquet) drop in
// transparently without a compile-time flag.
// ---------------------------------------------------------------------------

export function readSource(path: string, context?: string): string {
  // Guard the shape contract. The stored node config and the engine step
  // vocabulary are DIFFERENT: a persisted Join carries `rightNodeId`
  // (+ `conditions[].leftColumn/rightColumn`), while the compiler needs
  // `rightPath` (+ `on[].left/right`). Any caller that hands the stored
  // config straight to the compiler lands here with `path === undefined`,
  // and `path.replace` threw:
  //   TypeError: Cannot read properties of undefined (reading 'replace')
  //     at readSource → compileJoin → compileTransformChain
  // surfacing as an opaque 500 INTERNAL_ERROR. Name the actual problem
  // instead.
  if (typeof path !== 'string' || path.trim() === '') {
    throw new AppError(
      'Join/union input could not be resolved to a file path' +
        `${context ? ` (${context})` : ''}. The referenced node was not ` +
        'translated into an engine input — either it was deleted from the ' +
        'canvas, or the step still carries `rightNodeId` where the engine ' +
        'requires `rightPath`.',
      400,
      'TRANSFORM_INPUT_UNRESOLVED',
    );
  }
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
  compileSelect,
  compileSort,
  compileDropDuplicates,
  compileExpressions,
  compileApplyToMultipleColumns,
  compileComputeIfAbsent,
  compileAggregate,
  compileRollup,
  compileAggregateOnCondition,
  compileTopRows,
  compilePivot,
  compileUnpivot,
  compileKeepDuplicates,
  aggregateSql,
  rejectUnsupported,
};
