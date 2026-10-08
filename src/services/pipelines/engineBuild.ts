// ---------------------------------------------------------------------------
// Engine-backed pipeline build (DuckDB) — FOUNDRY-GAPS §1, CSV/join extension.
//
// WHY THIS EXISTS
// The legacy build path (TransformService.materializeForDeploy) materializes
// every intermediate as JS row objects: readCsvRows(file, MAX_SAFE_INTEGER)
// builds one object graph per row. For the 6,362,620-row / 471 MB PaySim
// source that is ~4.8 GB of V8 heap for a single output, and the join holds
// BOTH branches at once (~5.7 GB), so the process dies at Node's 4 GB
// default old-space cap. It is also silently WRONG for some chains: the TS
// evaluator's integer cast throws on a non-integral double, so
// amount_key = round(amount,2) came out NULL for ~11% of rows, and NULL
// never matches in a join — those pairs would vanish from the output.
//
// This module instead compiles the node graph to a sequence of DuckDB stages.
// Each stage is one SQL statement sunk with COPY ... TO PARQUET, so rows go
// engine -> disk and never enter the Node heap; the caller gets back a schema
// and a row count. Measured on the PaySim graph: 19s wall, ~790 MB peak Node
// RSS, versus ~5.7 GB required by the in-process path.
//
// WHY IT IS STAGED
// duckdbTransformEngine's JoinStep/UnionStep identify their right-hand input
// by FILE PATH (rightPath / otherPaths), and the compiler explicitly does not
// support "chained JOIN after transforms on the right input" (follow-5). Our
// graph needs exactly that (branch A/B are filter+rename chains). So a join or
// union node forces its inputs to be materialized first — hence the
// topological staging below.
//
// The legacy path remains the fallback: any compile failure, unsupported
// transform, or engine error propagates and the caller runs the in-process
// build unchanged.
// ---------------------------------------------------------------------------

import { compileTransformChain } from "./duckdbTransformEngine";
import type { TransformStep } from "./duckdbTransformEngine";
import { acquireConnection, releaseConnection } from "../duckdb/pool";
import { toDuckDbReadUri } from "../storageService";
import { statSync, rmSync, statfsSync } from "node:fs";

/** One materialised stage: a Parquet object the next stage can read. */
export interface EngineStage {
  /** Stable key used to resolve this stage as another node's input. */
  nodeId: string;
  /** Absolute path DuckDB can read (s3://… or /local/path). */
  path: string;
  rowCount: number;
}

/**
 * How the built output is published. Intermediate stages are ALWAYS Parquet
 * (typed + compact); only the final export honours this.
 */
export type EngineSinkFormat = "csv" | "parquet";

export interface EngineBuildResult {
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  /**
   * Canonical TYPED result (Parquet). The source of truth for schema and
   * row count; `exportPath` is what the dataset should publish.
   */
  sinkPath: string;
  /** Local file in the pipeline's output format, ready to stream to object storage. */
  exportPath: string;
  exportFormat: EngineSinkFormat;
  exportBytes: number;
  stages: EngineStage[];
  /** Intermediate stages unlinked mid-build (peak-disk control). */
  reclaimedStages: number;
  engine: "duckdb";
}

export interface EngineBuildDeps {
  /** nodeId -> { nodeType, config, sourceNodeId, datasetFilePath } */
  nodes: Map<string, PipelineNodeInfo>;
  /** Final publish format. `iceberg` is NOT handled here — see tryEngineBuild. */
  sinkFormat: EngineSinkFormat;
  /** Local scratch directory for intermediate Parquet stages. */
  stagingPrefix: string;
}

export interface PipelineNodeInfo {
  nodeId: string;
  nodeType: string;
  /** Raw node config (transforms, rightNodeId, mode, …). */
  config: Record<string, unknown>;
  sourceNodeId: string | null;
  /** Resolved read path for a `dataset` node; null for derived nodes. */
  datasetPath: string | null;
}

/** Transforms the SQL compiler refuses (mirrors transformService.needsLegacy). */
const LEGACY_ONLY = new Set(["Normalize", "UppercaseColumnNames", "RowSize", "FormatString", "CleanString"]);
const DATETIME_OP = /"(?:seconds_between|minutes_between|hours_between|days_between|add_seconds|add_minutes|add_hours|add_days)"/;

export class EngineIneligibleError extends Error {
  readonly code = "ENGINE_INELIGIBLE";
  constructor(reason: string) {
    super(reason);
    this.name = "EngineIneligibleError";
  }
}

/** Throws EngineIneligibleError when a chain cannot run on the engine. */
export function assertEngineEligible(transforms: unknown[]): void {
  for (const t of transforms) {
    const fn = (t as { function?: string })?.function ?? "";
    if (LEGACY_ONLY.has(fn)) {
      throw new EngineIneligibleError(`${fn} has no SQL equivalent (compute_type='legacy_nodejs' required)`);
    }
    if (DATETIME_OP.test(JSON.stringify(t))) {
      throw new EngineIneligibleError("datetime operators have no SQL translation yet");
    }
  }
}

/**
 * Translate a stored node config into engine steps.
 *
 * The stored shape and the engine shape DIVERGE for the two graph edges:
 *   - Join  : stored { rightNodeId, conditions:[{leftColumn,rightColumn}] }
 *             engine  { rightPath, on:[{left,right}] }
 *   - Union : stored config.rightNodeId / rightNodeIds + config.mode
 *             engine  { otherPath / otherPaths, mode }
 * Everything else (Cast, Rename, Filter, Drop, Select, Aggregate,
 * DropDuplicates, ApplyExpression, CaseExpression, ConcatenateStrings) is
 * stored in the engine's own vocabulary and passes through unchanged.
 */
function toEngineSteps(
  node: PipelineNodeInfo,
  resolveStage: (nodeId: string) => EngineStage,
): TransformStep[] {
  const cfg = node.config;
  const steps: TransformStep[] = [];
  // A union node stores its additional input(s) at CONFIG level, not in
  // transforms, so the Union step has to be placed explicitly.
  //
  // Palantir ordering: the union COMBINES the inputs into one table, and the
  // node's own transforms then run over that combined table. So the Union step
  // goes FIRST and the node's transforms follow it.
  //
  // This was previously appended LAST, which inverted the semantics: a
  // `DropDuplicates` authored on a union node ran on the LEFT input only
  // (already deduped by that node's own chain), and the dedup never applied to
  // the rows the union then appended — so the union silently reintroduced
  // duplicates the node was meant to remove. Ordering the Union first is what
  // makes "deduplicate on account_id after the union" expressible on the union
  // node itself.
  const unionIds = Array.isArray(cfg.rightNodeIds)
    ? (cfg.rightNodeIds as string[])
    : (typeof cfg.rightNodeId === "string" ? [cfg.rightNodeId] : []);
  if (unionIds.length > 0) {
    const paths = unionIds.map((id) => resolveStage(id).path);
    steps.push({
      function: "Union",
      otherPath: paths[0],
      ...(paths.length > 1 ? { otherPaths: paths.slice(1) } : {}),
      mode: (cfg.mode as "first" | "narrow" | "wide" | undefined) ?? "wide",
    } as unknown as TransformStep);
  }
  for (const raw of (cfg.transforms as unknown[]) ?? []) {
    const t = raw as Record<string, unknown>;
    if (t.function === "Join") {
      const right = resolveStage(String(t.rightNodeId));
      steps.push({
        function: "Join",
        rightPath: right.path,
        joinType: t.joinType as TransformStep extends { joinType: infer J } ? J : never,
        on: ((t.conditions as Array<Record<string, string>>) ?? []).map((c) => ({
          left: c.leftColumn,
          right: c.rightColumn,
        })),
      } as unknown as TransformStep);
      continue;
    }
    steps.push(raw as TransformStep);
  }
  return steps;
}

async function queryRows(conn: unknown, sql: string): Promise<Array<Record<string, unknown>>> {
  const c = conn as { stream: (s: string) => AsyncIterable<Record<string, unknown>> };
  const out: Array<Record<string, unknown>> = [];
  for await (const r of c.stream(sql)) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = typeof v === "bigint"
        ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v))
        : v;
    }
    out.push(o);
  }
  return out;
}

const q = (p: string) => `'${p.replace(/'/g, "''")}'`;

/**
 * Build one output node's chain on the engine. Returns the sink path plus the
 * row count; the caller registers the dataset. Throws
 * EngineIneligibleError when the graph cannot be expressed as engine stages.
 */
export async function buildWithEngine(
  outputNodeId: string,
  deps: EngineBuildDeps,
): Promise<EngineBuildResult> {
  const { nodes, stagingPrefix } = deps;
  const output = nodes.get(outputNodeId);
  if (!output) throw new EngineIneligibleError(`output node ${outputNodeId} not found`);

  const conn = await acquireConnection();

  // ── Bulk-export tuning ────────────────────────────────────────────
  // Measured: building transactions_clean (6,362,620 rows) died at
  // "952.0 MiB/953.6 MiB used" with DuckDB's defaults. Two causes, both
  // specific to building a file rather than querying interactively:
  //
  //  1. threads: each thread keeps its own hash table for joins/aggregates,
  //     so memory scales with the thread count. 8 cores × per-thread state
  //     oversubscribes the 1 GB default pool on a memory-constrained host.
  //  2. preserve_insertion_order: DuckDB then BUFFERS the whole result so it
  //     can emit rows in insertion order. For a 6.36M-row export that buffer
  //     is the entire result set — the single biggest win available, and the
  //     engine names it first in its own OOM remediation.
  //
  // TRADE-OFF: turning insertion-order preservation off means the exported
  // row order is NOT the source scan order and may vary between runs. No
  // expectation type is order-sensitive (count / null / distinct-key), and a
  // dataset is a set of rows, so this is safe — but it is a real behavioural
  // change and is why both knobs are env-overridable rather than hardcoded.
  const threads = Number(process.env.TELLUS_DUCKDB_THREADS ?? 4);
  const memoryLimit = process.env.TELLUS_DUCKDB_MEMORY_LIMIT ?? null;
  await queryRows(conn, `SET threads=${Number.isFinite(threads) && threads > 0 ? Math.floor(threads) : 4}`);
  await queryRows(conn, `SET preserve_insertion_order=${process.env.TELLUS_DUCKDB_PRESERVE_ORDER === "true" ? "true" : "false"}`);
  if (memoryLimit) await queryRows(conn, `SET memory_limit='${memoryLimit.replace(/'/g, "''")}'`);

  const stages = new Map<string, EngineStage>();
  const visiting = new Set<string>();
  /** nodeId -> how many nodes still need to read its stage. */
  const consumers = new Map<string, number>();
  /** Stages unlinked after their last read — surfaced for diagnostics. */
  const reclaimed: string[] = [];
  /** Chain root of THIS output; must outlive reclamation for schema+export. */
  let finalNodeId = '';
  const built: EngineStage[] = [];
  let stageSeq = 0;

  const resolveStage = (nodeId: string): EngineStage => {
    const st = stages.get(nodeId);
    if (!st) {
      throw new EngineIneligibleError(
        `node ${nodeId} is consumed before it was materialised — graph order is not topological`,
      );
    }
    return st;
  };

  /** Every node id this node consumes: its source PLUS join/union siblings. */
  const inputNodeIds = (node: PipelineNodeInfo): string[] => {
    const ids: string[] = [];
    if (node.sourceNodeId) ids.push(node.sourceNodeId);
    // A Join stores its right input on the transform; a Union stores it at
    // config level. Both are graph edges the engine needs as FILE PATHS, so
    // both must be materialised before this node can compile.
    for (const raw of (node.config.transforms as Array<Record<string, unknown>>) ?? []) {
      const rid = (raw as Record<string, unknown>)?.rightNodeId;
      if (typeof rid === "string") ids.push(rid);
    }
    for (const rid of (node.config.rightNodeIds as string[]) ?? []) ids.push(rid);
    if (typeof node.config.rightNodeId === "string") ids.push(node.config.rightNodeId);
    return [...new Set(ids)];
  };

  /** Materialise `nodeId` (and its whole ancestry) as one Parquet stage. */
  const materialise = async (nodeId: string, sinkPath: string): Promise<EngineStage> => {
    const cached = stages.get(nodeId);
    if (cached) return cached;
    if (visiting.has(nodeId)) {
      throw new EngineIneligibleError(`cycle detected at node ${nodeId}`);
    }
    visiting.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) throw new EngineIneligibleError(`node ${nodeId} not found`);

    try {
      // Materialise EVERY input first — not just sourceNodeId. A join's right
      // branch is a second input; skipping it is exactly the "consumed before
      // materialised" failure, and it must never be approximated away.
      const inputs = inputNodeIds(node);
      let inputPath: string;
      if (node.nodeType === "dataset") {
        if (!node.datasetPath) {
          throw new EngineIneligibleError(`dataset node ${nodeId} has no file path`);
        }
        inputPath = node.datasetPath;
      } else {
        if (inputs.length === 0) {
          throw new EngineIneligibleError(`node ${nodeId} has no input node`);
        }
        const head = nodes.get(inputs[0]);
        if (head?.nodeType === "dataset") {
          if (!head.datasetPath) {
            throw new EngineIneligibleError(`dataset node ${inputs[0]} has no file path`);
          }
          inputPath = head.datasetPath;
        } else {
          inputPath = (await materialiseInternal(inputs[0])).path;
        }
        // The remaining inputs (join right branch, union siblings).
        for (const other of inputs.slice(1)) {
          await materialiseInternal(other);
        }
      }

      const steps = toEngineSteps(node, resolveStage);
      assertEngineEligible(steps as unknown as unknown[]);
      const plan = compileTransformChain(steps, { inputPath });
      for (const pre of plan.preambles) await queryRows(conn, pre);
      await queryRows(conn, `COPY (${plan.sql}) TO ${q(sinkPath)} (FORMAT PARQUET)`);

      const [{ n }] = await queryRows(conn, `SELECT count(*)::BIGINT AS n FROM read_parquet(${q(sinkPath)})`);
      const stage: EngineStage = { nodeId, path: sinkPath, rowCount: Number(n) };
      stages.set(nodeId, stage);
      built.push(stage);

      // ── Reclaim consumed inputs (the disk-bounded part) ──────────
      // Every stage is a full-size Parquet (the 02 Keys stage alone is
      // 6,362,620 rows). Without reclamation a 15-node graph keeps ALL of
      // them alive until the build ends — which is how the PaySim deploy
      // died with `No space left on device` while writing the third
      // intermediate. Once every consumer of an input has been
      // materialised, nothing can read it again, so unlink it now.
      //
      // Refcounts come from the graph itself, so this is exact: a stage is
      // deleted on exactly its last read.
      for (const inp of inputNodeIds(node)) {
        if (inp === finalNodeId) continue; // needed for schema + export
        const left = (consumers.get(inp) ?? 1) - 1;
        consumers.set(inp, left);
        if (left > 0) continue;
        const st = stages.get(inp);
        if (!st) continue;
        try {
          rmSync(st.path, { force: true });
        } catch {
          // A stage we cannot delete is a space problem, not a correctness
          // one — the build can still finish, so do not fail it here.
        }
        stages.delete(inp);
        reclaimed.push(st.nodeId);
      }
      return stage;
    } finally {
      visiting.delete(nodeId);
    }
  };

  /** Intermediate materialisation for a node consumed by a join/union. */
  const materialiseInternal = async (nodeId: string): Promise<EngineStage> => {
    const seq = stageSeq++;
    return materialise(nodeId, `${stagingPrefix}${nodeId}-${seq}.parquet`);
  };

  // Refcounts must be known BEFORE the first materialisation, because
  // reclamation fires inside it.
  for (const n of nodes.values()) {
    for (const inp of inputNodeIds(n)) {
      consumers.set(inp, (consumers.get(inp) ?? 0) + 1);
    }
  }

  try {
    // The output node itself is just a pass-through to its source.
    const chainRoot = (() => {
      let cur: PipelineNodeInfo | undefined = output;
      while (cur && cur.nodeType === "output") {
        cur = cur.sourceNodeId ? nodes.get(cur.sourceNodeId) : undefined;
      }
      return cur;
    })();
    if (!chainRoot) throw new EngineIneligibleError("output node has no resolvable source");
    finalNodeId = chainRoot.nodeId;

    // Build the whole chain into a typed Parquet result. Schema + row count
    // are read back from THIS file, never inferred from the transforms, so a
    // compiler bug surfaces as a schema mismatch rather than silent drift.
    const scratch = `${stagingPrefix}result-${outputNodeId}.parquet`;
    const finalStage = await materialise(chainRoot.nodeId, scratch);

    // Publish in the pipeline's output format. CSV goes through a second
    // COPY so the Parquet above stays the typed canonical form.
    const exportPath = `${stagingPrefix}out-${outputNodeId}.${deps.sinkFormat}`;
    if (deps.sinkFormat === "csv") {
      await queryRows(conn,
        `COPY (SELECT * FROM read_parquet(${q(finalStage.path)})) ` +
        `TO ${q(exportPath)} (FORMAT CSV, HEADER)`);
    } else {
      await queryRows(conn,
        `COPY (SELECT * FROM read_parquet(${q(finalStage.path)})) ` +
        `TO ${q(exportPath)} (FORMAT PARQUET)`);
    }
    // Export size comes from the local file, not a SQL round-trip.
    const exportBytes = statSync(exportPath).size;

    // Column schema from the engine (DESCRIBE), normalised to the app's
    // lower-case type vocabulary that dataset_columns stores.
    const cols = await queryRows(conn,
      `DESCRIBE SELECT * FROM read_parquet(${q(finalStage.path)})`);

    return {
      columns: cols.map((c) => ({
        name: String(c.column_name),
        type: normaliseDuckDbType(String(c.column_type ?? "VARCHAR")),
      })),
      rowCount: finalStage.rowCount,
      sinkPath: finalStage.path,
      exportPath,
      exportFormat: deps.sinkFormat,
      exportBytes,
      stages: built,
      reclaimedStages: reclaimed.length,
      engine: "duckdb",
    };
  } finally {
    releaseConnection(conn);
  }
}

/** DuckDB type name -> the vocabulary dataset_columns already stores. */
export function normaliseDuckDbType(t: string): string {
  const s = t.toUpperCase().replace(/\(.*/, "").trim();
  switch (s) {
    case "BIGINT":
    case "HUGEINT":
    case "UBIGINT":
      return "integer";
    case "INTEGER":
    case "INT":
    case "INT4":
    case "SMALLINT":
    case "TINYINT":
      return "integer";
    case "DOUBLE":
    case "FLOAT":
    case "FLOAT4":
    case "FLOAT8":
    case "REAL":
      return "double";
    case "DECIMAL":
    case "NUMERIC":
      return "double";
    case "BOOLEAN":
    case "BOOL":
    case "LOGICAL":
      return "boolean";
    case "DATE":
      return "date";
    case "TIMESTAMP":
    case "DATETIME":
      return "datetime";
    case "TIME":
      return "string";
    default:
      return "string";
  }
}

/** Bytes free on the filesystem holding `dir`. */
export function freeBytes(dir: string): number {
  try {
    // statfs is available on every platform this runs on (linux/mac).
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER; // Unknown → do not block the build.
  }
}

/**
 * Refuse to start when the scratch filesystem cannot hold the build.
 *
 * A DuckDB build stages Parquet files the size of the dataset, so the
 * requirement scales with the input, not with the row count we discover
 * mid-flight. The earlier failure mode was a raw
 * `IO Error: Could not write file … No space left on device` surfacing as a
 * build failure minutes in — technically accurate, operationally useless.
 * This turns it into one actionable line before any work starts.
 *
 * `estimateFactor` is a deliberately generous multiple of the source size:
 * the widest live set is roughly two stages plus one export, and being wrong
 * low only means we fall back to the raw IO error we had before.
 */
export function assertScratchCapacity(args: {
  scratchDir: string;
  sourceBytes: number;
  estimateFactor?: number;
}): { freeBytes: number; requiredBytes: number } {
  const factor = args.estimateFactor ?? 3;
  const required = Math.ceil(args.sourceBytes * factor);
  const free = freeBytes(args.scratchDir);
  if (free < required) {
    throw new EngineIneligibleError(
      `not enough disk to build on the engine: ${args.scratchDir} has ` +
        `${formatBytes(free)} free but the build needs about ${formatBytes(required)} ` +
        `(~${factor}x the ${formatBytes(args.sourceBytes)} input). Free space, point ` +
        `TELLUS_PIPELINE_ENGINE_SCRATCH at a larger volume, or lower ` +
        `TELLUS_PIPELINE_ENGINE_DISABLED=true to force the in-process path.`,
    );
  }
  return { freeBytes: free, requiredBytes: required };
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Convenience: qualify a stored S3 object key for DuckDB's httpfs reader. */
export function engineReadPath(fileKey: string): string {
  return toDuckDbReadUri(fileKey);
}
