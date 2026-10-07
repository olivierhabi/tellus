// ---------------------------------------------------------------------------
// Funnel runtime configuration — versioned per-environment config.
//
// The five non-secret funnel knobs below used to be tuned through `.env`
// (FUNNEL_MERGE_OUT_OF_PROCESS, DUCKDB_CLI_PATH, DUCKDB_MEMORY_LIMIT,
// FUNNEL_INDEXING_STALL_AFTER_MS / FUNNEL_INDEXING_BOOT_STALE_MS, and the
// Lakekeeper/DuckDB S3 endpoint selection). That made production behaviour
// depend on unversioned operator state: a raised stall ceiling or a
// loopback S3 endpoint could hide a wedged run with no code change to
// review. These values are now committed here, keyed by deployment
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
  /** Progress-coupled Temporal heartbeat silence budget. */
  stageStallAfterMs: number;
  /** Run merge steps 2–8 in a separate DuckDB CLI process. */
  mergeOutOfProcess: boolean;
  /** PG-tail batch size (rows per keyset page). */
  mergeBatchSize: number;
  /** Keep the staging table on promotion failure for forensics. */
  mergeStagingRetainOnFailure: boolean;
  /** DuckDB CLI binary for the out-of-process path. */
  duckdbCliPath: string;
  /** DuckDB memory_limit for merge work. */
  duckdbMemoryLimit: string;
  /** S3 endpoint the Lakekeeper container must use (docker-internal name). */
  icebergContainerEndpoint: string;
  /** S3 endpoint host-run DuckDB should use (host-reachable name). */
  s3HostEndpoint: string;
}

const CONFIG: Record<FunnelRuntimeProfile, Omit<FunnelRuntimeConfig, "profile">> = {
  development: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeOutOfProcess: true,
    mergeBatchSize: 5_000,
    mergeStagingRetainOnFailure: false,
    duckdbCliPath: "duckdb",
    duckdbMemoryLimit: "8GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://127.0.0.1:9000",
  },
  test: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeOutOfProcess: false,
    mergeBatchSize: 5_000,
    mergeStagingRetainOnFailure: false,
    duckdbCliPath: "duckdb",
    duckdbMemoryLimit: "1GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://127.0.0.1:9000",
  },
  production: {
    indexingStallAfterMs: 600_000,
    indexingBootStaleMs: 900_000,
    indexingDeadAfterMs: 900_000,
    stageStallAfterMs: 60_000,
    mergeOutOfProcess: true,
    mergeBatchSize: 5_000,
    mergeStagingRetainOnFailure: false,
    duckdbCliPath: "/usr/local/bin/duckdb",
    duckdbMemoryLimit: "8GB",
    icebergContainerEndpoint: "http://minio:9000",
    s3HostEndpoint: "http://minio:9000",
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

/** The committed runtime config for this process. No per-knob env overrides. */
export function funnelRuntimeConfig(env: NodeJS.ProcessEnv = process.env): FunnelRuntimeConfig {
  const profile = funnelRuntimeProfile(env);
  return { profile, ...CONFIG[profile] };
}
