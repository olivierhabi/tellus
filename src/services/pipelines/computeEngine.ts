// ---------------------------------------------------------------------------
// ComputeEngine — the engine-neutral batch execution contract (FOUNDRY-GAPS §1).
//
// Foundry-parity rule: engines meet at ICEBERG, not Node arrays. An engine
// receives a compiled plan plus the Iceberg target and returns **stats, not
// rows** — the output lands in the lake via the engine's own Iceberg writer
// (Trino/Spark connector), bypassing materializeForDeploy's in-process arrays
// and the PyIceberg write-sidecar.
//
// DeploymentService.executeBuild() branches here per output node
// (strangler-fig): large inputs are compiled to engine SQL and dispatched;
// small data keeps the existing in-process path byte-identically.
// ---------------------------------------------------------------------------

export interface IcebergTarget {
  /** Lakekeeper warehouse name (e.g. tellus-pipeline). */
  warehouse: string;
  namespace: string;
  table: string;
  /** Lakekeeper REST catalog base URL. */
  catalogUri: string;
}

export interface EnginePlan {
  /** Ordered SQL statements; engine executes sequentially, fails fast. */
  statements: string[];
  /** Source identifiers for log/metrics correlation. */
  sources: string[];
  /** Sink identifier (fully-qualified output table). */
  sink: string;
}

export interface EngineExecutionResult {
  engine: string;
  /** Rows written to the sink (from the final DML statement). */
  rowCount: number;
  /** Engine-side wall time across all statements (ms). */
  elapsedMs: number;
  /** Engine query ids, one per executed statement (observability/lineage). */
  queryIds: string[];
}

export interface ComputeEngine {
  readonly name: string;
  /** True when the engine is reachable/configured for this deployment. */
  available(): Promise<boolean>;
  /**
   * Execute a compiled plan whose final statement writes into `target`.
   * Returns stats only — rows never transit the Node.js heap.
   */
  executePlan(
    plan: EnginePlan,
    target: IcebergTarget,
  ): Promise<EngineExecutionResult>;
}

// ---------------------------------------------------------------------------
// Engine selection. `TELLUS_BATCH_ENGINE` picks the batch engine for deploys:
//   - unset / "auto"  → engine path when a real Trino coordinator is
//                       configured (TRINO_URL set & reachable), else the
//                       in-process + PyIceberg-sidecar path. This is the
//                       default: the engine is the writer wherever the
//                       infrastructure exists, with a transparent fallback.
//   - "trino"         → always attempt the engine path (tests inject an
//                       in-memory engine via setTrinoEngineForTests).
//   - "in-process"    → force the legacy Node path (escape hatch).
//
// "auto" must NOT engage the NoopTrinoEngine (which reports available but
// writes nothing) — see trinoCoordinatorConfigured() in trinoAdapter.ts. That
// guard is why the default is safe: with no coordinator there is zero behavior
// change from the historical in-process default.
//
// `TELLUS_BATCH_ENGINE_MIN_ROWS` (default 500_000) is the strangler-fig
// threshold: pipelines whose pinned inputs are smaller stay in-process.
// ---------------------------------------------------------------------------

export type BatchEngineKind = "auto" | "in-process" | "trino";

export function selectedBatchEngine(): BatchEngineKind {
  const raw = (process.env.TELLUS_BATCH_ENGINE ?? "auto").toLowerCase();
  if (raw === "trino") return "trino";
  if (raw === "in-process" || raw === "inprocess" || raw === "node") {
    return "in-process";
  }
  return "auto";
}

export function batchEngineMinRows(): number {
  const raw = Number(process.env.TELLUS_BATCH_ENGINE_MIN_ROWS ?? "500000");
  return Number.isFinite(raw) && raw >= 0 ? raw : 500_000;
}

/**
 * Parse the two Iceberg location formats the platform records on
 * foundry_datasets.file_path / iceberg_location:
 *   `<warehouse>:<namespace>.<table>`            (Funnel convention)
 *   `<warehouse>/<namespace>/<table>#snapshot=N` (pipeline deploy convention)
 * Returns null for anything else (CSV/Parquet S3 keys).
 */
export function parseIcebergLocation(raw: string): {
  warehouse: string;
  namespace: string;
  table: string;
  snapshotId: string | null;
} | null {
  const colon = raw.match(/^([^:/]+):([^.]+(?:\.[^.]+)*)\.([^.]+)$/);
  if (colon) {
    return {
      warehouse: colon[1],
      namespace: colon[2],
      table: colon[3],
      snapshotId: null,
    };
  }
  // Slash form is exactly 3 segments, and must be distinguishable from a
  // generic S3 object key: either a #snapshot pin is present or the
  // namespace is a dotted/underscored Iceberg namespace (e.g. _pipeline.*).
  const slash = raw.match(/^([^/]+)\/([^/]+)\/([^/#]+)(?:#snapshot=(\d+))?$/);
  if (
    slash &&
    (slash[4] !== undefined || slash[2].includes(".") || slash[2].startsWith("_"))
  ) {
    return {
      warehouse: slash[1],
      namespace: slash[2],
      table: slash[3],
      snapshotId: slash[4] ?? null,
    };
  }
  return null;
}
