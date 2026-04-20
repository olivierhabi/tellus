// ---------------------------------------------------------------------------
// Pipeline-Builder Lakekeeper bootstrap — PB-B4.
//
// Spec literal (tasks-01.md PB-B4):
//   "The Iceberg writer path uses the existing services/funnel/icebergCatalog.ts
//    wrapper and lakekeeperClient.ts — do not introduce a parallel catalog
//    client."
//
// The Funnel's icebergCatalog.ts models a Postgres-backed shadow catalog
// for `_funnel.*` tables; the Pipeline Builder writes real Iceberg tables
// via PyIceberg (which talks Iceberg REST to Lakekeeper directly). What
// both subsystems must share is the SINGLE TypeScript Lakekeeper client
// so bootstrap operations (warehouse create, namespace ensure) don't
// drift. This module delegates every catalog operation to
// `funnel/lakekeeperClient.ts` — it's the Funnel wrapper, reused — and
// intentionally does NOT instantiate its own HTTP client.
//
// Usage: call ensurePipelineWarehouse() at server startup (src/server.ts
// runs it in parallel with the funnel bootstrap). ensurePipelineNamespace
// is called lazily from deploymentService before the first sidecar call
// per (project, pipeline) pair.
// ---------------------------------------------------------------------------

import { getLakekeeperClient, type WarehouseConfig } from "../funnel/lakekeeperClient";
import { pipelineNamespace } from "./icebergNamespace";

const PIPELINE_WAREHOUSE =
  process.env.LAKEKEEPER_PIPELINE_WAREHOUSE ?? "tellus-pipeline";

let warehouseBootstrappedAt: number | null = null;
const WAREHOUSE_RECHECK_MS = 10 * 60 * 1000;

function warehouseConfig(): WarehouseConfig {
  // In production (NODE_ENV=production) we refuse to boot with the dev
  // defaults — a silent "minioadmin" credential in a prod pod is worse
  // than a loud crash. In dev/test we keep the docker-compose defaults
  // so the stack comes up with zero env-var wiring.
  const isProd = process.env.NODE_ENV === "production";
  const accessKeyId = process.env.MINIO_ACCESS_KEY ?? (isProd ? "" : "minioadmin");
  const secretAccessKey =
    process.env.MINIO_SECRET_KEY ?? (isProd ? "" : "minioadmin");
  if (isProd && (!accessKeyId || !secretAccessKey)) {
    throw new Error(
      "MINIO_ACCESS_KEY / MINIO_SECRET_KEY are required in production — " +
        "the `minioadmin` dev defaults are blocked.",
    );
  }
  return {
    warehouseName: PIPELINE_WAREHOUSE,
    // MinIO bucket for _pipeline.* data files — separate from the
    // Funnel's bucket so storage quotas and lifecycle policies can be
    // tuned independently.
    bucket: process.env.LAKEKEEPER_PIPELINE_BUCKET ?? "tellus-pipeline",
    endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
    accessKeyId,
    secretAccessKey,
    region: process.env.MINIO_REGION ?? "us-east-1",
    pathStyleAccess: true,
  };
}

/**
 * Idempotently ensure the `tellus-pipeline` warehouse exists in
 * Lakekeeper. Uses the shared `getLakekeeperClient()` — NO parallel
 * HTTP client. Memoised for 10 minutes so repeat deploys don't hammer
 * the management API.
 */
export async function ensurePipelineWarehouse(): Promise<string> {
  const now = Date.now();
  if (warehouseBootstrappedAt && now - warehouseBootstrappedAt < WAREHOUSE_RECHECK_MS) {
    return PIPELINE_WAREHOUSE;
  }
  const client = getLakekeeperClient();
  if (!(await client.isReachable())) {
    throw new Error(
      "Lakekeeper unreachable — cannot bootstrap pipeline warehouse",
    );
  }
  await client.ensureWarehouse(warehouseConfig());
  warehouseBootstrappedAt = now;
  return PIPELINE_WAREHOUSE;
}

/**
 * Ensure the `_pipeline.<project>.<pipeline>` namespace exists under
 * the pipeline warehouse. Idempotent; delegates to the shared
 * `lakekeeperClient.ensureNamespace`.
 */
export async function ensurePipelineNamespace(
  projectSlug: string,
  pipelineSlug: string,
): Promise<string> {
  await ensurePipelineWarehouse();
  const client = getLakekeeperClient();
  const ns = pipelineNamespace(projectSlug, pipelineSlug);
  await client.ensureNamespace(PIPELINE_WAREHOUSE, ns);
  return ns;
}

export function pipelineWarehouseName(): string {
  return PIPELINE_WAREHOUSE;
}

/** Test-only: force the next ensurePipelineWarehouse() call to re-hit Lakekeeper. */
export function __resetPipelineWarehouseCacheForTesting(): void {
  warehouseBootstrappedAt = null;
}
