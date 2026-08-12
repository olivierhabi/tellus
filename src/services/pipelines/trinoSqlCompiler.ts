// ---------------------------------------------------------------------------
// Trino SQL compiler — FOUNDRY-GAPS §1 (batch analog of flinkSqlCompiler).
//
// Compiles a batch pipeline's transform DAG to a Trino SQL script:
//   * sources are Iceberg tables resolved through the Lakekeeper REST
//     catalog (the `iceberg` Trino catalog) — the engine reads the lake
//     directly, no CSV re-parse, no Node arrays;
//   * the final statement is `INSERT INTO <sink> SELECT ...` so the
//     engine's native Iceberg writer commits the snapshot (the REST
//     catalog handles OCC — no manual retry loop needed);
//   * the full batch op set is supported: Cast / Filter / Normalize /
//     Rename / Drop / Join / Union.
//
// Normalize semantics (the one non-obvious op, nailed down here): it is a
// COMPILE-TIME projection rename. Column names are known at compile time,
// so we emit `SELECT <col> AS <lower_snake_case(col)>` — spaces, hyphens
// and dots become underscores, runs collapse, and with
// removeSpecialCharacters every remaining non-[a-z0-9_] char is stripped.
// This matches applyExistingTransforms() in transformService.ts exactly,
// and needs no engine UDF (the reason Normalize is rejected on Flink).
//
// The compiler is side-effect-free; it produces text. Submission lives in
// trinoAdapter.ts. Tests pin the emitted SQL without a Trino cluster.
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";
import type {
  TransformStep,
  FilterCondition,
} from "./duckdbTransformEngine";
import type { EnginePlan, IcebergTarget } from "./computeEngine";

export interface BatchSourceTable {
  id: string;
  label: string;
  /** Iceberg location of the input: namespace + table in the catalog. */
  namespace: string;
  table: string;
  columns: Array<{ name: string; type: string }>;
  /** Pin the read to a snapshot for reproducible builds (Iceberg time travel). */
  snapshotId?: string | null;
}

export interface CompileBatchInput {
  /** Trino catalog name bound to the Lakekeeper REST catalog. */
  catalog: string;
  inputs: BatchSourceTable[];
  transforms: TransformStep[];
  /** When omitted, the schema is derived from the folded transform chain. */
  outputSchema?: Array<{ name: string; type: string }>;
  output: IcebergTarget;
}

export interface CompiledBatchJob extends EnginePlan {
  /** The schema the sink table was declared with (for dataset bookkeeping). */
  outputSchema: Array<{ name: string; type: string }>;
}

export function compileBatchJob(input: CompileBatchInput): CompiledBatchJob {
  if (input.inputs.length === 0) {
    throw new AppError(
      "Batch pipeline needs at least one source dataset.",
      400,
      "BATCH_NO_SOURCES",
    );
  }

  const catalog = quoteIdent(input.catalog);
  const primary = input.inputs[0];
  const sources = input.inputs.map((s) => sourceRef(input.catalog, s));

  // Working SELECT state: we fold each transform into projection/predicates.
  let columns = primary.columns.map((c) => ({
    expr: quoteIdent(c.name),
    name: c.name,
    type: c.type,
  }));
  let from = `${sourceRef(input.catalog, primary)} AS t0`;
  const predicates: string[] = [];
  let aliasIdx = 1;
  const unions: string[] = [];

  for (const step of input.transforms) {
    switch (step.function) {
      case "Cast": {
        const target = mapTrinoType(step.targetType);
        const out = step.outputColumn ?? step.expression;
        const idx = columns.findIndex((c) => c.name === step.expression);
        const castExpr = `TRY_CAST(${quoteIdent(step.expression)} AS ${target})`;
        if (idx >= 0 && out === step.expression) {
          columns[idx] = { expr: castExpr, name: out, type: step.targetType };
        } else {
          columns.push({ expr: castExpr, name: out, type: step.targetType });
        }
        break;
      }
      case "Filter": {
        const parts = (step.conditions ?? []).map(renderCondition);
        if (parts.length === 0) break;
        const joined = parts.join(step.match === "any" ? " OR " : " AND ");
        predicates.push(
          step.mode === "drop" ? `NOT (${joined})` : `(${joined})`,
        );
        break;
      }
      case "Drop": {
        const dropped = new Set(step.columns);
        columns = columns.filter((c) => !dropped.has(c.name));
        if (columns.length === 0) {
          throw new AppError(
            "Drop removed every column.",
            400,
            "BATCH_TRANSFORM_INVALID",
          );
        }
        break;
      }
      case "Rename": {
        for (const r of step.renames) {
          const col = columns.find((c) => c.name === r.from);
          if (col) col.name = r.to;
        }
        break;
      }
      case "Normalize": {
        for (const col of columns) {
          col.name = normalizeName(col.name, step.removeSpecialCharacters);
        }
        break;
      }
      case "Join": {
        if (step.joinType === "cross" && !step.allowCrossJoin) {
          throw new AppError(
            "Cross join requires allowCrossJoin (cardinality guard).",
            400,
            "BATCH_TRANSFORM_INVALID",
          );
        }
        const right = input.inputs.find(
          (s) => s.id === step.rightPath || s.label === step.rightAlias,
        );
        if (!right) {
          throw new AppError(
            `Join right side "${step.rightAlias ?? step.rightPath}" is not a registered Iceberg input.`,
            400,
            "BATCH_JOIN_INPUT_NOT_ICEBERG",
          );
        }
        const alias = `t${aliasIdx++}`;
        const joinKind =
          step.joinType === "cross"
            ? "CROSS JOIN"
            : `${step.joinType.toUpperCase()}${step.joinType === "full" ? " OUTER" : ""} JOIN`;
        const on =
          step.joinType === "cross"
            ? ""
            : ` ON ${(step.on ?? [])
                .map(
                  (k) =>
                    `t0.${quoteIdent(k.left)} = ${alias}.${quoteIdent(k.right)}`,
                )
                .join(" AND ")}`;
        if (step.joinType !== "cross" && (!step.on || step.on.length === 0)) {
          throw new AppError(
            "Join requires at least one equi-join key.",
            400,
            "BATCH_TRANSFORM_INVALID",
          );
        }
        from += ` ${joinKind} ${sourceRef(input.catalog, right)} AS ${alias}${on}`;
        // Right columns join the projection; collisions get the right_ prefix
        // (matches executeJoin() semantics in transformService.ts).
        const leftNames = new Set(columns.map((c) => c.name));
        for (const rc of right.columns) {
          const name = leftNames.has(rc.name) ? `right_${rc.name}` : rc.name;
          columns.push({
            expr: `${alias}.${quoteIdent(rc.name)}`,
            name,
            type: rc.type,
          });
        }
        break;
      }
      case "Union": {
        // Union-by-name against another registered input; emitted as a
        // UNION ALL block over the final projection (null-fill for columns
        // missing on the right, matching the in-process union).
        const u = step as unknown as { rightPath?: string; rightAlias?: string };
        const right = input.inputs.find(
          (s) => s.id === u.rightPath || s.label === u.rightAlias,
        );
        if (!right) {
          throw new AppError(
            `Union right side is not a registered Iceberg input.`,
            400,
            "BATCH_UNION_INPUT_NOT_ICEBERG",
          );
        }
        const rightNames = new Set(right.columns.map((c) => c.name));
        const proj = columns
          .map((c) =>
            rightNames.has(c.name)
              ? `${quoteIdent(c.name)} AS ${quoteIdent(c.name)}`
              : `CAST(NULL AS VARCHAR) AS ${quoteIdent(c.name)}`,
          )
          .join(", ");
        unions.push(`SELECT ${proj} FROM ${sourceRef(input.catalog, right)}`);
        break;
      }
      default:
        throw new AppError(
          `Unsupported batch transform: ${(step as { function?: string }).function}`,
          400,
          "BATCH_TRANSFORM_NOT_SUPPORTED",
        );
    }
  }

  // Final projection must line up with the declared output schema. When the
  // caller didn't declare one, the folded chain IS the schema.
  const outputSchema =
    input.outputSchema && input.outputSchema.length > 0
      ? input.outputSchema
      : columns.map((c) => ({ name: c.name, type: c.type }));
  const byName = new Map(columns.map((c) => [c.name, c]));
  const projection = outputSchema
    .map((out) => {
      const col = byName.get(out.name);
      if (!col) {
        throw new AppError(
          `Output column "${out.name}" is not produced by the transform chain.`,
          400,
          "BATCH_SCHEMA_MISMATCH",
        );
      }
      return `${col.expr} AS ${quoteIdent(out.name)}`;
    })
    .join(", ");

  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  let select = `SELECT ${projection} FROM ${from}${where}`;
  for (const u of unions) select += ` UNION ALL ${u}`;

  const sinkSchema = `${catalog}.${quoteIdent(input.output.namespace)}`;
  const sink = `${sinkSchema}.${quoteIdent(input.output.table)}`;
  const ddlCols = outputSchema
    .map((c) => `${quoteIdent(c.name)} ${mapTrinoType(c.type)}`)
    .join(", ");

  return {
    statements: [
      `CREATE SCHEMA IF NOT EXISTS ${sinkSchema}`,
      `CREATE TABLE IF NOT EXISTS ${sink} (${ddlCols}) WITH (format = 'PARQUET')`,
      `INSERT INTO ${sink} ${select}`,
    ],
    sources,
    sink,
    outputSchema,
  };
}

// ---------------------------------------------------------------------------
// Node fusion (FOUNDRY-GAPS §1): join / union NODES whose two input arms are
// each a linear transform chain rooted at an Iceberg table. This is what
// retires the in-process array path (materializeForDeploy's executeJoin /
// union rebase) for large pipelines — both arms are folded to SELECT
// subqueries and the join/union is composed in Trino, so rows never transit
// the Node heap. Multi-way joins (3+ inputs) and joins-of-joins still fall
// back to in-process (a future planner concern); the dominant two-input
// shape is fused here.
// ---------------------------------------------------------------------------

export interface LinearArm {
  source: BatchSourceTable;
  /** Linear ops only (Cast/Filter/Drop/Rename/Normalize). */
  transforms: TransformStep[];
}

export interface FusedJoinSpec {
  kind: "join";
  joinType: "inner" | "left" | "right" | "full" | "cross";
  on: Array<{ left: string; right: string }>;
  rightPrefix?: string;
  allowCrossJoin?: boolean;
  /** Optional output column whitelists (post-transform names), per arm. */
  leftSelected?: string[];
  rightSelected?: string[];
}

export interface FusedUnionSpec {
  kind: "union";
}

export interface CompileFusedInput {
  catalog: string;
  left: LinearArm;
  right: LinearArm;
  fusion: FusedJoinSpec | FusedUnionSpec;
  output: IcebergTarget;
}

interface FoldedArm {
  /** A complete SELECT exposing clean output column names. */
  select: string;
  columns: Array<{ name: string; type: string }>;
}

/**
 * Fold a linear transform chain (no Join/Union) over a single Iceberg source
 * into one SELECT subquery that exposes the post-transform column names. Used
 * for each arm of a fused join/union.
 */
export function foldLinearArm(
  catalog: string,
  arm: LinearArm,
): FoldedArm {
  let columns = arm.source.columns.map((c) => ({
    expr: quoteIdent(c.name),
    name: c.name,
    type: c.type,
  }));
  const predicates: string[] = [];

  for (const step of arm.transforms) {
    switch (step.function) {
      case "Cast": {
        const target = mapTrinoType(step.targetType);
        const out = step.outputColumn ?? step.expression;
        const idx = columns.findIndex((c) => c.name === step.expression);
        const castExpr = `TRY_CAST(${quoteIdent(step.expression)} AS ${target})`;
        if (idx >= 0 && out === step.expression) {
          columns[idx] = { expr: castExpr, name: out, type: step.targetType };
        } else {
          columns.push({ expr: castExpr, name: out, type: step.targetType });
        }
        break;
      }
      case "Filter": {
        const parts = (step.conditions ?? []).map(renderCondition);
        if (parts.length === 0) break;
        const joined = parts.join(step.match === "any" ? " OR " : " AND ");
        predicates.push(step.mode === "drop" ? `NOT (${joined})` : `(${joined})`);
        break;
      }
      case "Drop": {
        const dropped = new Set(step.columns);
        columns = columns.filter((c) => !dropped.has(c.name));
        if (columns.length === 0) {
          throw new AppError("Drop removed every column.", 400, "BATCH_TRANSFORM_INVALID");
        }
        break;
      }
      case "Rename": {
        for (const r of step.renames) {
          const col = columns.find((c) => c.name === r.from);
          if (col) col.name = r.to;
        }
        break;
      }
      case "Normalize": {
        for (const col of columns) {
          col.name = normalizeName(col.name, step.removeSpecialCharacters);
        }
        break;
      }
      default:
        // Join/Union inside an arm chain is not a linear op — the graph
        // walker must have mis-classified the arm; refuse so the caller
        // falls back to in-process rather than emit wrong SQL.
        throw new AppError(
          `Arm chain may only contain linear ops, got "${(step as { function?: string }).function}".`,
          400,
          "BATCH_ARM_NOT_LINEAR",
        );
    }
  }

  const projection = columns
    .map((c) => `${c.expr} AS ${quoteIdent(c.name)}`)
    .join(", ");
  const where = predicates.length ? ` WHERE ${predicates.join(" AND ")}` : "";
  return {
    select: `SELECT ${projection} FROM ${sourceRef(catalog, arm.source)}${where}`,
    columns: columns.map((c) => ({ name: c.name, type: c.type })),
  };
}

/**
 * Compile a two-arm join or union NODE to a Trino CREATE+INSERT script. Parity
 * targets: executeJoin() (right_ prefix on name collision, per-arm column
 * selection, outer-join null fill) and the union-by-name rebase (unique union
 * with left ordering, null-fill) in transformService.ts.
 */
export function compileFusedJob(input: CompileFusedInput): CompiledBatchJob {
  const catalog = quoteIdent(input.catalog);
  const left = foldLinearArm(input.catalog, input.left);
  const right = foldLinearArm(input.catalog, input.right);

  let select: string;
  let outputSchema: Array<{ name: string; type: string }>;

  if (input.fusion.kind === "join") {
    const f = input.fusion;
    if (f.joinType === "cross" && !f.allowCrossJoin) {
      throw new AppError(
        "Cross join requires allowCrossJoin (cardinality guard).",
        400,
        "BATCH_TRANSFORM_INVALID",
      );
    }
    if (f.joinType !== "cross" && (!f.on || f.on.length === 0)) {
      throw new AppError("Join requires at least one equi-join key.", 400, "BATCH_TRANSFORM_INVALID");
    }
    const leftSel = f.leftSelected ? new Set(f.leftSelected) : null;
    const rightSel = f.rightSelected ? new Set(f.rightSelected) : null;
    const filteredLeft = leftSel ? left.columns.filter((c) => leftSel.has(c.name)) : left.columns;
    const filteredRight = rightSel ? right.columns.filter((c) => rightSel.has(c.name)) : right.columns;
    const leftNames = new Set(filteredLeft.map((c) => c.name));

    const projParts: string[] = [];
    const outCols: Array<{ name: string; type: string }> = [];
    for (const c of filteredLeft) {
      projParts.push(`t0.${quoteIdent(c.name)} AS ${quoteIdent(c.name)}`);
      outCols.push({ name: c.name, type: c.type });
    }
    for (const c of filteredRight) {
      const outName = leftNames.has(c.name) ? `${f.rightPrefix ?? "right_"}${c.name}` : c.name;
      projParts.push(`t1.${quoteIdent(c.name)} AS ${quoteIdent(outName)}`);
      outCols.push({ name: outName, type: c.type });
    }

    const joinKind =
      f.joinType === "cross"
        ? "CROSS JOIN"
        : `${f.joinType.toUpperCase()}${f.joinType === "full" ? " OUTER" : ""} JOIN`;
    const on =
      f.joinType === "cross"
        ? ""
        : ` ON ${f.on
            .map((k) => `t0.${quoteIdent(k.left)} = t1.${quoteIdent(k.right)}`)
            .join(" AND ")}`;

    select =
      `SELECT ${projParts.join(", ")} ` +
      `FROM (${left.select}) AS t0 ${joinKind} (${right.select}) AS t1${on}`;
    outputSchema = outCols;
  } else {
    // Union by name: unique union of columns, left ordering preserved,
    // null-fill missing names on each side.
    const seen = new Set<string>();
    outputSchema = [];
    for (const c of [...left.columns, ...right.columns]) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        outputSchema.push({ name: c.name, type: c.type });
      }
    }
    const armProj = (arm: FoldedArm): string => {
      const have = new Set(arm.columns.map((c) => c.name));
      return outputSchema
        .map((o) =>
          have.has(o.name)
            ? `${quoteIdent(o.name)} AS ${quoteIdent(o.name)}`
            : `CAST(NULL AS ${mapTrinoType(o.type)}) AS ${quoteIdent(o.name)}`,
        )
        .join(", ");
    };
    select =
      `SELECT ${armProj(left)} FROM (${left.select}) AS l ` +
      `UNION ALL SELECT ${armProj(right)} FROM (${right.select}) AS r`;
  }

  const sinkSchema = `${catalog}.${quoteIdent(input.output.namespace)}`;
  const sink = `${sinkSchema}.${quoteIdent(input.output.table)}`;
  const ddlCols = outputSchema
    .map((c) => `${quoteIdent(c.name)} ${mapTrinoType(c.type)}`)
    .join(", ");

  return {
    statements: [
      `CREATE SCHEMA IF NOT EXISTS ${sinkSchema}`,
      `CREATE TABLE IF NOT EXISTS ${sink} (${ddlCols}) WITH (format = 'PARQUET')`,
      `INSERT INTO ${sink} ${select}`,
    ],
    sources: [
      sourceRef(input.catalog, input.left.source),
      sourceRef(input.catalog, input.right.source),
    ],
    sink,
    outputSchema,
  };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function sourceRef(catalog: string, s: BatchSourceTable): string {
  const base = `${quoteIdent(catalog)}.${quoteIdent(s.namespace)}.${quoteIdent(s.table)}`;
  // Iceberg time travel — reproducible builds read a pinned snapshot.
  return s.snapshotId
    ? `${base} FOR VERSION AS OF ${BigInt(s.snapshotId)}`
    : base;
}

function renderCondition(c: FilterCondition): string {
  const col = quoteIdent(c.column);
  const val = () => `'${escapeSql(c.value ?? "")}'`;
  // Right-hand operand: literal by default; column reference when the
  // condition compares column-to-column (valueIsColumn).
  const rhs = c.valueIsColumn
    ? `CAST(${quoteIdent(c.value ?? "")} AS VARCHAR)`
    : val();
  const colStr = `CAST(${col} AS VARCHAR)`;
  switch (c.operator) {
    case "eq":
      return `${colStr} = ${rhs}`;
    case "neq":
      return `${colStr} <> ${rhs}`;
    case "starts_with":
      return c.valueIsColumn
        ? `starts_with(${colStr}, ${rhs})`
        : `${colStr} LIKE '${escapeLike(c.value ?? "")}%' ESCAPE '\\'`;
    case "ends_with":
      return c.valueIsColumn
        ? `ends_with(${colStr}, ${rhs})`
        : `${colStr} LIKE '%${escapeLike(c.value ?? "")}' ESCAPE '\\'`;
    case "contains":
      return c.valueIsColumn
        ? `strpos(${colStr}, ${rhs}) > 0`
        : `${colStr} LIKE '%${escapeLike(c.value ?? "")}%' ESCAPE '\\'`;
    case "is_null":
      return c.treatEmptyAsNull
        ? `(${col} IS NULL OR ${colStr} = '')`
        : `${col} IS NULL`;
    case "is_not_null":
      return c.treatEmptyAsNull
        ? `(${col} IS NOT NULL AND ${colStr} <> '')`
        : `${col} IS NOT NULL`;
    case "regex_find":
      return `REGEXP_LIKE(${colStr}, ${val()})`;
    case "regex_match":
      return `REGEXP_LIKE(${colStr}, '^(?:${escapeSql(c.value ?? "")})$')`;
    default:
      throw new AppError(
        `Unsupported filter operator: ${(c as { operator?: string }).operator}`,
        400,
        "BATCH_TRANSFORM_NOT_SUPPORTED",
      );
  }
}

export function normalizeName(
  name: string,
  removeSpecialCharacters?: boolean,
): string {
  let out = name
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/_+/g, "_");
  if (removeSpecialCharacters) out = out.replace(/[^a-z0-9_]/g, "");
  return out.replace(/_+/g, "_").replace(/^_|_$/g, "") || name.toLowerCase();
}

export function mapTrinoType(t: string): string {
  switch (t.toLowerCase()) {
    case "integer":
      return "BIGINT";
    case "numeric":
    case "double":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP(6)";
    case "string":
    default:
      return "VARCHAR";
  }
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function escapeSql(v: string): string {
  return v.replace(/'/g, "''");
}

function escapeLike(v: string): string {
  return escapeSql(v).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
