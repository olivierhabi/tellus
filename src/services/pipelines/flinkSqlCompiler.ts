// ---------------------------------------------------------------------------
// Flink SQL compiler — PB-B5.
//
// Compiles a streaming pipeline's transform DAG to a Flink SQL script
// consisting of:
//   * `CREATE TABLE <source>_<idx> WITH (...)` for each dataset node
//     (Kafka source if the upstream `foundry_datasets.kind='stream'`,
//     Iceberg source for batch-fed inputs).
//   * `CREATE TABLE <sink> WITH ('connector'='iceberg', ...)` for the
//     output table — two-phase commit enabled by default.
//   * A final `INSERT INTO sink SELECT ...` that interprets the
//     declarative transforms.
//
// The supported transform subset for v1 (per the PB-B5 spec's risk
// callout): projection, filter, simple equi-join, union-all. Cast /
// Drop / Rename are projections. Anything else — windowed joins, late
// events, user-defined transforms — is rejected at compile time with
// STREAMING_TRANSFORM_NOT_SUPPORTED.
//
// The compiler is side-effect-free; it produces text. Submission lives
// in flinkAdapter.ts. Tests can pin the emitted SQL without a Flink
// cluster.
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";
import type { TransformStep } from "./duckdbTransformEngine";

export interface DatasetNode {
  id: string;
  label: string;
  kind: "stream" | "batch";
  /** Kafka topic (kind='stream') or s3 URI / iceberg table (kind='batch'). */
  source: string;
  columns: Array<{ name: string; type: string }>;
  /** Kafka-specific: bootstrap servers override. */
  bootstrapServers?: string;
  /** Format override. Default: kafka→json, batch→parquet/iceberg from URI. */
  format?: "json" | "avro" | "parquet" | "iceberg";
}

export interface StreamingJobPlan {
  /** Ordered DDL then DML; concat with ';\n'. */
  statements: string[];
  /** Source and sink identifiers for log/metrics correlation. */
  sources: string[];
  sink: string;
}

export interface CompileStreamingInput {
  jobName: string;
  inputs: DatasetNode[];
  transforms: TransformStep[];
  outputSchema: Array<{ name: string; type: string }>;
  outputIceberg: {
    warehouse: string;
    namespace: string;
    table: string;
    catalogUri: string;
  };
  parallelism?: number;
}

export function compileStreamingJob(
  input: CompileStreamingInput,
): StreamingJobPlan {
  if (input.inputs.length === 0) {
    throw new AppError(
      "Streaming pipeline needs at least one source dataset.",
      400,
      "STREAMING_NO_SOURCES",
    );
  }
  for (const step of input.transforms) {
    assertSubsetSupported(step);
  }

  const statements: string[] = [];
  const sourceNames: string[] = [];
  input.inputs.forEach((node, i) => {
    const name = `src_${i}_${sqlIdent(node.label)}`;
    statements.push(renderSourceDdl(name, node));
    sourceNames.push(name);
  });

  const sink = `sink_${sqlIdent(input.outputIceberg.table)}`;
  statements.push(renderIcebergSinkDdl(sink, input));

  const select = renderStreamingSelect({
    sources: sourceNames,
    transforms: input.transforms,
    outputSchema: input.outputSchema,
  });
  statements.push(`INSERT INTO ${quoteIdent(sink)} ${select}`);

  return { statements, sources: sourceNames, sink };
}

// ---------------------------------------------------------------------------
// Subset guard — reject anything the v1 runtime can't honestly execute.
// ---------------------------------------------------------------------------

function assertSubsetSupported(step: TransformStep): void {
  switch (step.function) {
    case "Cast":
    case "Drop":
    case "Rename":
    case "Union":
      return;
    case "Filter":
      return;
    case "Join": {
      if (step.joinType === "cross") {
        throw new AppError(
          "Cross joins are not supported on streaming pipelines.",
          400,
          "STREAMING_TRANSFORM_NOT_SUPPORTED",
        );
      }
      if (!step.on || step.on.length === 0) {
        throw new AppError(
          "Streaming joins require at least one equi-join key.",
          400,
          "STREAMING_TRANSFORM_NOT_SUPPORTED",
        );
      }
      return;
    }
    case "Normalize":
      throw new AppError(
        "Normalize is not supported on streaming pipelines (no Flink UDF shipped).",
        400,
        "STREAMING_TRANSFORM_NOT_SUPPORTED",
      );
    default:
      throw new AppError(
        `Unsupported streaming transform: ${(step as { function?: string }).function}`,
        400,
        "STREAMING_TRANSFORM_NOT_SUPPORTED",
      );
  }
}

// ---------------------------------------------------------------------------
// DDL emitters.
// ---------------------------------------------------------------------------

function renderSourceDdl(name: string, node: DatasetNode): string {
  const cols = node.columns
    .map((c) => `  ${quoteIdent(c.name)} ${mapFlinkType(c.type)}`)
    .join(",\n");
  if (node.kind === "stream") {
    const format = node.format ?? "json";
    const bootstrap = node.bootstrapServers ?? "${KAFKA_BOOTSTRAP_SERVERS}";
    return (
      `CREATE TABLE ${quoteIdent(name)} (\n${cols}\n) WITH (\n` +
      `  'connector' = 'kafka',\n` +
      `  'topic' = '${escapeSql(node.source)}',\n` +
      `  'properties.bootstrap.servers' = '${escapeSql(bootstrap)}',\n` +
      `  'properties.group.id' = 'tellus-pb-b5-${escapeSql(name)}',\n` +
      `  'scan.startup.mode' = 'earliest-offset',\n` +
      `  'format' = '${escapeSql(format)}'\n` +
      `)`
    );
  }
  // batch-fed input. Format by URI suffix: iceberg://, s3://...parquet
  if (/^iceberg:\/\//i.test(node.source)) {
    const ident = node.source.replace(/^iceberg:\/\//i, "");
    return (
      `CREATE TABLE ${quoteIdent(name)} (\n${cols}\n) WITH (\n` +
      `  'connector' = 'iceberg',\n` +
      `  'catalog-name' = 'tellus_pipeline',\n` +
      `  'catalog-database' = '${escapeSql(ident.split(".").slice(0, -1).join("."))}',\n` +
      `  'catalog-table' = '${escapeSql(ident.split(".").pop() ?? "")}',\n` +
      `  'streaming' = 'true'\n` +
      `)`
    );
  }
  const format = node.format ?? "parquet";
  return (
    `CREATE TABLE ${quoteIdent(name)} (\n${cols}\n) WITH (\n` +
    `  'connector' = 'filesystem',\n` +
    `  'path' = '${escapeSql(node.source)}',\n` +
    `  'format' = '${escapeSql(format)}'\n` +
    `)`
  );
}

function renderIcebergSinkDdl(sink: string, input: CompileStreamingInput): string {
  const cols = input.outputSchema
    .map((c) => `  ${quoteIdent(c.name)} ${mapFlinkType(c.type)}`)
    .join(",\n");
  return (
    `CREATE TABLE ${quoteIdent(sink)} (\n${cols}\n) WITH (\n` +
    `  'connector' = 'iceberg',\n` +
    `  'catalog-name' = 'tellus_pipeline',\n` +
    `  'catalog-type' = 'rest',\n` +
    `  'uri' = '${escapeSql(input.outputIceberg.catalogUri)}',\n` +
    `  'warehouse' = '${escapeSql(input.outputIceberg.warehouse)}',\n` +
    `  'catalog-database' = '${escapeSql(input.outputIceberg.namespace)}',\n` +
    `  'catalog-table' = '${escapeSql(input.outputIceberg.table)}',\n` +
    `  'write.upsert.enabled' = 'false',\n` +
    // Flink Iceberg connector two-phase commit lives behind
    // `write.format.default=parquet` + Flink's exactly-once checkpoint.
    // We leave checkpoint config to job submit (see flinkAdapter).
    `  'format-version' = '2'\n` +
    `)`
  );
}

// ---------------------------------------------------------------------------
// SELECT emitter — deliberately the simplest layout that matches the
// DuckDB compiler's CTE shape (tN_src → tN_cast → tN_filter → ...).
// ---------------------------------------------------------------------------

function renderStreamingSelect(input: {
  sources: string[];
  transforms: TransformStep[];
  outputSchema: Array<{ name: string; type: string }>;
}): string {
  const ctes: string[] = [];
  ctes.push(`src AS (SELECT * FROM ${quoteIdent(input.sources[0])})`);
  let current = "src";

  input.transforms.forEach((step, idx) => {
    const next = `t${idx + 1}`;
    switch (step.function) {
      case "Cast":
        ctes.push(`${next} AS (${compileCastFlink(step, current)})`);
        break;
      case "Drop":
        ctes.push(
          `${next} AS (SELECT * EXCEPT (${(step.columns ?? []).map(quoteIdent).join(", ")}) FROM ${current})`,
        );
        break;
      case "Rename": {
        const map = new Map<string, string>();
        for (const r of step.renames ?? []) map.set(r.from, r.to);
        const pairs = Array.from(map.entries())
          .map(([f, t]) => `${quoteIdent(f)} AS ${quoteIdent(t)}`)
          .join(", ");
        ctes.push(
          `${next} AS (SELECT *, ${pairs} FROM ${current})`,
        );
        break;
      }
      case "Filter":
        ctes.push(`${next} AS (${compileFilterFlink(step, current)})`);
        break;
      case "Union": {
        // PB-B5 v1 supports UNION ALL against another source table by
        // path — we resolve it to the nearest registered source.
        ctes.push(
          `${next} AS (SELECT * FROM ${current} UNION ALL SELECT * FROM ${quoteIdent(resolveUnionSource(step.otherPath, input.sources))})`,
        );
        break;
      }
      case "Join": {
        const rightName = resolveUnionSource(step.rightPath, input.sources);
        const on = (step.on ?? [])
          .map(
            (p) =>
              `l.${quoteIdent(p.left)} = r.${quoteIdent(p.right)}`,
          )
          .join(" AND ");
        const kind = step.joinType.toUpperCase();
        ctes.push(
          `${next} AS (SELECT * FROM ${current} AS l ${kind} JOIN ${quoteIdent(rightName)} AS r ON ${on})`,
        );
        break;
      }
      default:
        throw new AppError(
          `Streaming compiler reached default branch for ${(step as { function?: string }).function}`,
          500,
          "STREAMING_COMPILER_BUG",
        );
    }
    current = next;
  });

  const projection = input.outputSchema.length > 0
    ? input.outputSchema.map((c) => quoteIdent(c.name)).join(", ")
    : "*";
  return `WITH ${ctes.join(",\n     ")}\nSELECT ${projection} FROM ${current}`;
}

function compileCastFlink(
  step: Extract<TransformStep, { function: "Cast" }>,
  from: string,
): string {
  const source = quoteIdent(step.expression);
  const out = quoteIdent(step.outputColumn ?? step.expression);
  const sqlType = mapFlinkType(step.targetType);
  if (step.outputColumn && step.outputColumn !== step.expression) {
    return `SELECT *, TRY_CAST(${source} AS ${sqlType}) AS ${out} FROM ${from}`;
  }
  return `SELECT * EXCEPT (${source}), TRY_CAST(${source} AS ${sqlType}) AS ${out} FROM ${from}`;
}

function compileFilterFlink(
  step: Extract<TransformStep, { function: "Filter" }>,
  from: string,
): string {
  const mode = step.mode ?? "keep";
  const match = step.match ?? "all";
  if (!step.conditions || step.conditions.length === 0) {
    return `SELECT * FROM ${from}`;
  }
  const exprs = step.conditions.map((c) => `(${flinkCondition(c)})`);
  const joined = match === "all" ? exprs.join(" AND ") : exprs.join(" OR ");
  const predicate = mode === "keep" ? joined : `NOT (${joined})`;
  return `SELECT * FROM ${from} WHERE ${predicate}`;
}

function flinkCondition(c: {
  column: string;
  operator: string;
  value?: string;
  valueIsColumn?: boolean;
}): string {
  const col = quoteIdent(c.column);
  const v = (c.value ?? "").replace(/'/g, "''");
  // Right-hand operand: literal by default; column reference when the
  // condition compares column-to-column (valueIsColumn).
  const rhs = c.valueIsColumn
    ? `CAST(${quoteIdent(c.value ?? "")} AS STRING)`
    : `'${v}'`;
  switch (c.operator) {
    case "eq":
      return `CAST(${col} AS STRING) = ${rhs}`;
    case "neq":
      return `CAST(${col} AS STRING) <> ${rhs}`;
    case "starts_with":
      return c.valueIsColumn
        ? `CAST(${col} AS STRING) LIKE ${rhs} || '%'`
        : `CAST(${col} AS STRING) LIKE '${v}%'`;
    case "ends_with":
      return c.valueIsColumn
        ? `CAST(${col} AS STRING) LIKE '%' || ${rhs}`
        : `CAST(${col} AS STRING) LIKE '%${v}'`;
    case "contains":
      return c.valueIsColumn
        ? `CAST(${col} AS STRING) LIKE '%' || ${rhs} || '%'`
        : `CAST(${col} AS STRING) LIKE '%${v}%'`;
    case "is_null":
      return `${col} IS NULL`;
    case "is_not_null":
      return `${col} IS NOT NULL`;
    default:
      throw new AppError(
        `Streaming filter operator not supported: ${c.operator}`,
        400,
        "STREAMING_TRANSFORM_NOT_SUPPORTED",
      );
  }
}

function resolveUnionSource(path: string, sources: string[]): string {
  // For v1 we require Union / Join right-hand path to reference a
  // source registered on the pipeline by its label. We allow either a
  // bare label ("orders_topic") or the fully-qualified src name.
  const asSrc = sources.find((s) => s === path || s.endsWith(`_${sqlIdent(path)}`));
  if (asSrc) return asSrc;
  throw new AppError(
    `Streaming Union/Join right-side '${path}' is not registered as a source on this pipeline.`,
    400,
    "STREAMING_TRANSFORM_NOT_SUPPORTED",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqlIdent(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unnamed";
}

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function escapeSql(value: string): string {
  return String(value).replace(/'/g, "''");
}

function mapFlinkType(t: string): string {
  switch ((t ?? "").toLowerCase()) {
    case "integer":
    case "int":
    case "long":
    case "bigint":
      return "BIGINT";
    case "numeric":
    case "double":
    case "float":
      return "DOUBLE";
    case "boolean":
    case "bool":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMP(3)";
    default:
      return "STRING";
  }
}
