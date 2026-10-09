// ---------------------------------------------------------------------------
// Funnel runtime configuration — versioned per-environment config.
//
// The non-secret funnel knobs below used to be tuned through `.env`
// (FUNNEL_MERGE_OUT_OF_PROCESS, DUCKDB_CLI_PATH, DUCKDB_MEMORY_LIMIT,
// FUNNEL_INDEXING_STALL_AFTER_MS / FUNNEL_INDEXING_BOOT_STALE_MS, and the
// Lakekeeper/DuckDB S3 endpoint selection). That made production behaviour
// depend on unversioned operator state: a raised stall ceiling or a
// loopback S3 endpoint could hide a wedged run with no code change to
// review. The stage-heartbeat stall budget (FUNNEL_STAGE_STALL_AFTER_MS)
// and the merge-CLI hard timeout (FUNNEL_MERGE_CLI_TIMEOUT_MS) were retired
// the same way, and so were the merge strategy switches (MERGE_DELTA,
// MERGE_FAST_PATH, MERGE_NARROW_DEDUP, MERGE_BUCKET_ROWS,
// MERGE_PROGRESS_TTL_SECONDS) — see docs/adr/2026-10-09-funnel-merge-
// strategy-config.md. Like Palantir Funnel, strategy selection is an
// internal, deterministic decision of the pipeline (proven result-
// equivalent by tests), not per-host operator state. These values are now committed here, keyed by deployment
// profile, so every change is reviewable and every environment's numbers
// are stated in one place.
//
// Profiles:
//   * development — single-stack host loopback (`tellus-dev`).
//   * test        — destructive-test lanes (`tellus-tests-*`, NODE_ENV=test).
//   * production  — strict deployments (NODE_ENV=production or
//                   TELLUS_DEPLOYMENT_STRICT=1). No implicit host fallbacks.
//
// Secrets (S3 credentials, Lakekeeper PG encryption key) are NOT here —
// they come from the secret manager / gitignored env and are read with
// requireSecret at the call site.
// ---------------------------------------------------------------------------

export type FunnelRuntimeProfile = "development" | "test" | "production";

export interface FunnelRuntimeConfig {
  profile: FunnelRuntimeProfile;
  /** Movement watchdog: no last_progress_at advance for this long => STALLED. */
  indexingStallAfterMs: number;
  /** Boot grace for locks with no live owner. */
  indexingBootStaleMs: number;
  /** Dead-process budget: no lease_heartbeat_at for this long => owner dead. */
  indexingDeadAfterMs: number;
  /** Progress-coupled Temporal heartbeat silence budget. Also the
   *  out-of-process merge CLI's bytes-on-disk stall budget. */
  stageStallAfterMs: number;
  /** Hard wall-clock ceiling for ONE out-of-process merge CLI script. */
  mergeCliTimeoutMs: number;
  /** Run merge steps 2–8 in a separate DuckDB CLI process. */
  mergeOutOfProcess: boolean;
  /** PG-tail batch size (rows per keyset page). */
  mergeBatchSize: number;
  /** Staged rows per statement for the chunked verify / promote / cleanup
   *  of merge_staging_instances. Must keep one statement well inside
   *  PG_STATEMENT_TIMEOUT_MS (60 s) and well inside stageStallAfterMs. */
  mergePromoteChunkRows: number;
  /** Keep the staging table on promotion failure for forensics. */
  mergeStagingRetainOnFailure: boolean;
  /** Load the merge tail into staging with DuckDB CSV export + PG
   *  `COPY FROM STDIN` (bulk) instead of the per-row keyset loop. */
  mergeStagingBulkCopy: boolean;
  /** Merged docs per Kafka produce request in the indexing stage. */
  indexingPublishBatchSize: number;
  /** DuckDB CLI binary for the out-of-process path. */
  duckdbCliPath: string;
  /** DuckDB memory_limit for merge work. */
  duckdbMemoryLimit: string;
  /** S3 endpoint the Lakekeeper container must use (docker-internal name). */
  icebergContainerEndpoint: string;
  /** S3 endpoint host-run DuckDB should use (host-reachable name). */
  s3HostEndpoint: string;
  /** Delta PG tail: ship only rows changed vs the previous merged snapshot. */
  mergeDelta: boolean;
  /** Single-source fast path when the precheck proves it equivalent. */
  mergeFastPath: boolean;
  /** Narrow-key dedup SQL shape (vs the legacy wide sort). */
  mergeNarrowDedup: boolean;
  /** Target rows per hash bucket; <= 0 disables bucketing. */
  mergeBucketTargetRows: number;
  /** Redis merge-checkpoint TTL (>= longest PG tail + retry backoff). */
  mergeProgressTtlSeconds: number;
}

const CONFIG: Record<FunnelRuntimeProfile, Omit<FunnelRuntimeConfig, "profile">> = {
  development: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeCliTimeoutMs: 1_800_000,
    mergeOutOfProcess: true,
    mergeBatchSize: 5_000,
    mergePromoteChunkRows: 250_000,
    mergeStagingRetainOnFailure: false,
    mergeStagingBulkCopy: true,
    indexingPublishBatchSize: 1_000,
    duckdbCliPath: "duckdb",
    duckdbMemoryLimit: "8GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://127.0.0.1:9000",
    mergeDelta: true,
    mergeFastPath: true,
    mergeNarrowDedup: true,
    mergeBucketTargetRows: 1_000_000,
    mergeProgressTtlSeconds: 3_600,
  },
  test: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeCliTimeoutMs: 1_800_000,
    mergeOutOfProcess: false,
    mergeBatchSize: 5_000,
    mergePromoteChunkRows: 250_000,
    mergeStagingRetainOnFailure: false,
    mergeStagingBulkCopy: true,
    indexingPublishBatchSize: 1_000,
    duckdbCliPath: "duckdb",
    duckdbMemoryLimit: "1GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://127.0.0.1:9000",
    mergeDelta: true,
    mergeFastPath: true,
    mergeNarrowDedup: true,
    mergeBucketTargetRows: 1_000_000,
    mergeProgressTtlSeconds: 3_600,
  },
  production: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeCliTimeoutMs: 1_800_000,
    mergeOutOfProcess: true,
    mergeBatchSize: 5_000,
    mergePromoteChunkRows: 250_000,
    mergeStagingRetainOnFailure: false,
    mergeStagingBulkCopy: true,
    indexingPublishBatchSize: 1_000,
    duckdbCliPath: "/usr/local/bin/duckdb",
    duckdbMemoryLimit: "8GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://minio:9000",
    mergeDelta: true,
    mergeFastPath: true,
    mergeNarrowDedup: true,
    mergeBucketTargetRows: 1_000_000,
    mergeProgressTtlSeconds: 3_600,
  },
};

/** Resolve the versioned profile from deployment identity (never from tuning knobs). */
export function funnelRuntimeProfile(env: NodeJS.ProcessEnv = process.env): FunnelRuntimeProfile {
  if (env.NODE_ENV === "production" || env.TELLUS_DEPLOYMENT_STRICT === "1") {
    return "production";
  }
  const envId = (env.TELLUS_ENVIRONMENT_ID ?? "").trim();
  if (env.NODE_ENV === "test" || envId === "tellus-tests-main" || envId.startsWith("tellus-tests")) {
    return "test";
  }
  return "development";
}

type FunnelRuntimeOverrides = Partial<Omit<FunnelRuntimeConfig, "profile">>;
let testOverrides: FunnelRuntimeOverrides | null = null;

/**
 * Test-only, in-process override of committed values (e.g. force the
 * bucketed merge on a 6-row fixture). Never sourced from env or files, and
 * refused outside a vitest worker, so it cannot become operator state.
 * Pass `null` to clear.
 */
export function setFunnelRuntimeOverridesForTesting(overrides: FunnelRuntimeOverrides | null): void {
  if (overrides !== null && process.env.VITEST !== "true") {
    throw new Error("setFunnelRuntimeOverridesForTesting is only available under vitest");
  }
  testOverrides = overrides;
}

/** The committed runtime config for this process. No per-knob env overrides. */
export function funnelRuntimeConfig(env: NodeJS.ProcessEnv = process.env): FunnelRuntimeConfig {
  const profile = funnelRuntimeProfile(env);
  return { profile, ...CONFIG[profile], ...(testOverrides ?? {}) };
}
