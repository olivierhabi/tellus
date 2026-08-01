// ---------------------------------------------------------------------------
// Temporal Worker Versioning — FUNN-ISO-3.
//
// WHAT IS CONFIGURED HERE (Temporal-supported routing, not just logging):
//   * Workers poll with a commit-derived `buildId` + `useVersioning: true`
//     (SDK 1.16 WorkerOptions; the fields are flagged @deprecated in favor
//     of Worker Deployments — see WHY-NOT-DEPLOYMENTS below — but they are
//     functionally supported by SDK 1.16 / server 1.25).
//   * The task queue carries Temporal Build-ID ASSIGNMENT + REDIRECT RULES
//     (server v0.31 "task-queue versioning", experimental in server 1.25),
//     provisioned by scripts/provision-task-queue-versioning.sh:
//       - assignment rules = which build IDs may receive NEW executions
//         (ramp-percentage rollout),
//       - redirect rules   = compatible-build upgrade: work assigned to
//         build X is processed by build Y (X declared compatible with Y).
//   * Worker boot REFUSES to poll a queue whose assignment rules exist but
//     don't route to this build — unless TELLUS_TEMPORAL_VERSIONING=0 (the
//     documented escape hatch for legacy poller fleets, audited by
//     scripts/verify-temporal-pollers.sh).
//
// POLICY (the pinned/auto-upgrade declaration the audit asked for):
//   * Funnel workflows are PINNED: an in-flight workflow pinned to build B
//     is finished by build B. Deployments therefore keep the previous
//     compatible worker alive until every workflow of the old build drains
//     (`temporal task-queue describe`/workflow metrics; monitored by
//     scripts/temporal-versioning.sh status).
//   * NEW workflow runs AUTO-UPGRADE: the current assignment rule routes
//     100% of new executions to the latest compatible build after the
//     rollout script inserts the rule.
//   * Rollback: re-point the assignment rule back to the previous build id;
//     in-flight workflows on the newer build keep their pinned target (the
//     rerun of a crashed NEW-build workflow cannot silently hop to the old
//     binary — that hop IS what a redirect rule declares compatible =
//     false by default).
//
// WHY NOT WORKER DEPLOYMENTS (workerDeploymentOptions):
//   Empirical evidence (recorded in .migration-evidence/incidents):
//   @temporalio worker's bundled proto lacks DescribeWorkerDeployment/
//   ListWorkerDeployments/SetWorkerDeploymentCurrentVersion and the
//   OperatorService lacks UpdateWorkerBuildIdCompatibility; the bundled
//   container server image is temporalio/auto-setup:1.25.2 (Worker
//   Deployments need server >= 1.28). Both questions were probed live.
// ---------------------------------------------------------------------------

import {
  DeploymentConfigurationError,
  type EnvironmentIdentity,
} from "../../../config/environmentIdentity";

export const FUNNEL_DEPLOYMENT_NAME = "tellus-funnel";

export interface WorkerVersioningConfig {
  enabled: boolean;
  deploymentName: string;
  buildId: string;
}

export function resolveWorkerVersioningConfig(
  identity: EnvironmentIdentity,
  env: NodeJS.ProcessEnv = process.env,
): WorkerVersioningConfig {
  const raw = (env.TELLUS_TEMPORAL_VERSIONING ?? "1").trim();
  if (!["0", "1"].includes(raw)) {
    throw new DeploymentConfigurationError(
      `TELLUS_TEMPORAL_VERSIONING='${raw}' must be '1' (enabled) or '0' (disabled).`,
      "TELLUS_TEMPORAL_VERSIONING",
    );
  }
  return {
    enabled: raw === "1",
    deploymentName: FUNNEL_DEPLOYMENT_NAME,
    buildId: identity.workerBuildId,
  };
}

/**
 * WorkerOptions fragment: SDK WorkerOptions.buildId + useVersioning (marked
 * deprecated in 1.16 types — the functional routing API on this server).
 */
export interface VersionedWorkerOptionsFragment {
  buildId: string;
  useVersioning: true;
}

export function versionedWorkerOptions(
  cfg: WorkerVersioningConfig,
): VersionedWorkerOptionsFragment | Record<string, never> {
  return cfg.enabled
    ? { buildId: cfg.buildId, useVersioning: true }
    : {};
}

// ---------------------------------------------------------------------------
// Queue routing self-provisioning (local/verify stacks; infra-owned in
// strict mode).
//
// With versioning enabled on a 1.25 queue, NEW workflow executions are
// routed by Build-ID assignment rules — with NO rule, the execution router
// has no target and the run dead-heads (probe phase "baseline",
// scripts/temporal-probe). Every environment-owned worker therefore claims
// the routing rule for its own commit-derived buildId at boot:
//   * rule already routes to this buildId → no-op (idempotent),
//   * rules exist routed to an EARLIER buildId → insert this build at slot 0
//     AND register an addCompatibleRedirectRule(previous → this): the
//     lineage is auto-upgrade for new runs, pinned for in-flight histories,
//   * strict production mode: no self-provisioning — the mismatch is
//     logged and thrown; deployment infrastructure owns the rules.
// Concurrent boots race on the conflict token: FAILED_PRECONDITION on a
// stale token is re-tried once from a fresh read.
// ---------------------------------------------------------------------------

interface WorkflowServiceLike {
  getWorkerVersioningRules(req: unknown): Promise<unknown>;
  updateWorkerVersioningRules(req: unknown): Promise<unknown>;
}

interface QueuedRules {
  assignmentRules?: { rule?: { targetBuildId?: string } }[];
  redirectRules?: { sourceBuildId?: string; targetBuildId?: string }[];
  conflictToken?: unknown;
}

export async function ensureQueueAssignmentRule(
  client: { workflowService: WorkflowServiceLike },
  opts: {
    namespace: string;
    taskQueue: string;
    buildId: string;
    strict: boolean;
    maxAttempts?: number;
  },
): Promise<{ provisioned: boolean; previousRule?: string }> {
  const { namespace, taskQueue, buildId, strict } = opts;
  const attempts = opts.maxAttempts ?? 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const rules = (await client.workflowService.getWorkerVersioningRules({
        namespace,
        taskQueue,
      })) as QueuedRules;
      const current = rules.assignmentRules?.[0]?.rule?.targetBuildId;
      if (current === buildId) {
        return { provisioned: false };
      }
      if (strict) {
        throw new Error(
          `task queue '${taskQueue}' does NOT route to build '${buildId}' ` +
            `(current: '${current ?? "<none>"}') — strict mode forbids ` +
            `worker-side provisioning; deployment infrastructure must set ` +
            `the routing rule (scripts/temporal-versioning.ts promote).`,
        );
      }
      let token = rules.conflictToken;
      const previous = current;
      const inserted = (await client.workflowService.updateWorkerVersioningRules({
        namespace,
        taskQueue,
        conflictToken: token,
        insertAssignmentRule: { ruleIndex: 0, rule: { targetBuildId: buildId, percentageRamp: {} } },
      })) as QueuedRules;
      token = inserted.conflictToken ?? token;
      if (previous) {
        // Declare compatible lineage: older-build executions being retried/
        // restarted route forward to this build; in-flight runs stay pinned.
        await client.workflowService.updateWorkerVersioningRules({
          namespace,
          taskQueue,
          conflictToken: token,
          addCompatibleRedirectRule: { sourceBuildId: previous, targetBuildId: buildId },
        });
      }
      console.log(
        JSON.stringify({
          level: "info",
          type: "temporal_queue_routing_provisioned",
          namespace,
          taskQueue,
          buildId,
          previousTargetBuildId: previous ?? null,
        }),
      );
      return { provisioned: true, previousRule: previous };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const staleToken = /conflict token/i.test(msg);
      if (staleToken && attempt < attempts) continue;
      if (strict) throw err;
      console.warn(
        `[temporal] failed to provision queue routing rule for build '${buildId}' on '${taskQueue}': ${msg}`,
      );
      return { provisioned: false };
    }
  }
  return { provisioned: false };
}
