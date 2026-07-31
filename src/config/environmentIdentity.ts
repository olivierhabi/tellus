// ---------------------------------------------------------------------------
// Deployment environment identity — Task FUNN-ISO-1
//
// Single source of truth for "which logical deployment is this process?".
// Every Temporal worker, client, workflow starter, scheduler, migration,
// cleanup, and test process MUST derive its (environmentId, namespace,
// task queue, build id) from here — never from inline `?? "tellus-funnel"`
// fallbacks. The split-brain incident of 2026-07-31 (dev API on :3000 and
// the automate-verify API on :3100 polling the same `tellus-funnel` /
// `tellus-funnel-queue` and executing each other's activities against the
// wrong PostgreSQL database) was possible precisely because both stacks
// fell through to identical implicit defaults.
//
// Contract:
//   * TELLUS_ENVIRONMENT_ID   — identity of the deployment (e.g. "tellus-dev",
//                               "tellus-automate-verify-<stackId>", "tellus-prod").
//   * TEMPORAL_NAMESPACE      — Temporal namespace this deployment owns.
//   * TEMPORAL_TASK_QUEUE     — task queue this deployment's workers poll.
//   * TEMPORAL_WORKER_BUILD_ID— version/commit of the worker build (optional;
//                               resolved from git when absent).
//
// STRICT mode (production-like environments):
//   Activated when NODE_ENV=production OR TELLUS_DEPLOYMENT_STRICT=1.
//   TELLUS_ENVIRONMENT_ID, TEMPORAL_NAMESPACE and TEMPORAL_TASK_QUEUE are all
//   REQUIRED — startup fails fast with an actionable error when any is absent.
//   Implicit defaults are forbidden: two mis-set copies of the same
//   environment must not silently land on the same queue again.
//
// LOCAL mode (single-stack developer loopback):
//   Defaults resolve deterministically FROM the environment id
//   (`tellus-dev` → ns/queue `tellus-funnel-tellus-dev`), so a second stack
//   with a different environment id NEVER collides with the first. The
//   defaults are explicit and centralized here — the "clearly defined
//   local-development configuration" the isolation contract requires.
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import os from "os";

/** Thrown when deployment identity configuration is absent or invalid. */
export class DeploymentConfigurationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "DeploymentConfigurationError";
    this.field = field;
  }
}

export interface EnvironmentIdentity {
  /** Logical deployment id, e.g. "tellus-dev". Immutable per database. */
  environmentId: string;
  /** Temporal namespace this deployment owns. */
  temporalNamespace: string;
  /** Temporal task queue this deployment's workers poll. */
  temporalTaskQueue: string;
  /** Temporal frontend address. */
  temporalAddress: string;
  /** Worker version/commit (TEMPORAL_WORKER_BUILD_ID ?? git HEAD ?? "dev"). */
  workerBuildId: string;
  /** "strict" = production-like (no implicit defaults); "local" = dev. */
  mode: "strict" | "local";
  /** Process-level worker identity string used for Temporal poller
   *  attribution: `<envId>:<pid>@<hostname>`. */
  workerIdentity: string;
}

/** Ids/namespaces/queues allowed characters (Temporal namespace rules). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Locally-scoped default environment id for the single-stack dev loop. */
export const LOCAL_DEV_ENVIRONMENT_ID = "tellus-dev";

export function isStrictMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.TELLUS_DEPLOYMENT_STRICT === "1";
}

function resolveBuildId(env: NodeJS.ProcessEnv): string {
  const explicit = env.TEMPORAL_WORKER_BUILD_ID?.trim();
  if (explicit) {
    if (!SAFE_ID.test(explicit)) {
      throw new DeploymentConfigurationError(
        `TEMPORAL_WORKER_BUILD_ID='${explicit}' contains characters outside ` +
          `[A-Za-z0-9._-]. Set a clean version or commit id.`,
        "TEMPORAL_WORKER_BUILD_ID",
      );
    }
    return explicit;
  }
  try {
    return (
      execSync("git rev-parse --short=12 HEAD", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() || "dev"
    );
  } catch {
    return "dev";
  }
}

let cachedIdentity: EnvironmentIdentity | null = null;

/**
 * Resolve (and cache) the process's deployment identity. Throws
 * `DeploymentConfigurationError` in strict mode when identity fields are
 * absent — callers at startup boundaries should let this propagate so the
 * process refuses to boot with an actionable message.
 */
export function resolveEnvironmentIdentity(
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentIdentity {
  const strict = isStrictMode(env);

  const environmentId = env.TELLUS_ENVIRONMENT_ID?.trim();
  if (!environmentId) {
    if (strict) {
      throw new DeploymentConfigurationError(
        "TELLUS_ENVIRONMENT_ID is required in production-like environments " +
          "(NODE_ENV=production or TELLUS_DEPLOYMENT_STRICT=1). Set it to the " +
          "logical deployment id (e.g. 'tellus-prod'); the Temporal namespace, " +
          "task queue, and database seal are all derived from/validated against it.",
        "TELLUS_ENVIRONMENT_ID",
      );
    }
  }
  const envId = environmentId || LOCAL_DEV_ENVIRONMENT_ID;
  if (!SAFE_ID.test(envId)) {
    throw new DeploymentConfigurationError(
      `TELLUS_ENVIRONMENT_ID='${envId}' is invalid; use [A-Za-z0-9._-].`,
      "TELLUS_ENVIRONMENT_ID",
    );
  }

  const namespace = env.TEMPORAL_NAMESPACE?.trim();
  if (!namespace && strict) {
    throw new DeploymentConfigurationError(
      "TEMPORAL_NAMESPACE is required in production-like environments. " +
        "Provision it through deployment infrastructure and set it explicitly — " +
        "implicit namespace defaults are forbidden because two stacks sharing a " +
        "namespace+queue execute each other's activities (FUNN-ISO incident).",
      "TEMPORAL_NAMESPACE",
    );
  }
  const taskQueue = env.TEMPORAL_TASK_QUEUE?.trim();
  if (!taskQueue && strict) {
    throw new DeploymentConfigurationError(
      "TEMPORAL_TASK_QUEUE is required in production-like environments. " +
        "Set it explicitly; it must not be shared across deployments that use " +
        "different databases.",
      "TEMPORAL_TASK_QUEUE",
    );
  }

  // Local-mode defaults derive deterministically from the environment id so
  // distinct stacks never collide — there is NO hidden fallback that returns
  // two stacks to the same namespace.
  const ns = namespace || `tellus-funnel-${envId}`;
  const queue = taskQueue || `tellus-funnel-queue-${envId}`;
  for (const [field, value] of [
    ["TEMPORAL_NAMESPACE", ns],
    ["TEMPORAL_TASK_QUEUE", queue],
  ] as const) {
    if (!SAFE_ID.test(value)) {
      throw new DeploymentConfigurationError(
        `${field}='${value}' is invalid; use [A-Za-z0-9._-].`,
        field,
      );
    }
  }

  const workerBuildId = resolveBuildId(env);
  // Poller identity carries env + build so `temporal task-queue describe`
  // audits can attribute every poller to an approved deployment (FUNN-ISO-8).
  const workerIdentity = `${envId}:${workerBuildId}:${process.pid}@${os.hostname()}`;

  return {
    environmentId: envId,
    temporalNamespace: ns,
    temporalTaskQueue: queue,
    temporalAddress: env.TEMPORAL_ADDRESS?.trim() || "localhost:7233",
    workerBuildId,
    mode: strict ? "strict" : "local",
    workerIdentity,
  };
}

/**
 * Cached accessor for the process-wide identity. Resolution itself is cheap
 * but the git fallback forks a child — cache it.
 */
export function getEnvironmentIdentity(): EnvironmentIdentity {
  if (!cachedIdentity) cachedIdentity = resolveEnvironmentIdentity();
  return cachedIdentity;
}

/** Reset the cached identity — test helper only. */
export function __resetEnvironmentIdentityForTesting(): void {
  cachedIdentity = null;
}

/** Structured one-line identity summary for startup logs (no secrets). */
export function identityLogFields(id: EnvironmentIdentity): Record<string, unknown> {
  return {
    environmentId: id.environmentId,
    mode: id.mode,
    temporalAddress: id.temporalAddress,
    temporalNamespace: id.temporalNamespace,
    temporalTaskQueue: id.temporalTaskQueue,
    workerBuildId: id.workerBuildId,
    workerIdentity: id.workerIdentity,
  };
}
