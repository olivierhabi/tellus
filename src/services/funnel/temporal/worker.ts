// ---------------------------------------------------------------------------
// Temporal worker bootstrap — Task B3 + FUNN-ISO
//
// Registers the ObjectTypeFunnelWorkflow + activities against a Temporal
// namespace + task queue OWNED BY THIS DEPLOYMENT. Called from
// `src/server.ts` at boot.
//
// FUNN-ISO isolation guarantees (defense in depth):
//   1. Identity: namespace/task queue/environment come from
//      config/environmentIdentity.ts — REQUIRED in strict (production-like)
//      mode; deterministic env-id-derived defaults in local dev. Two stacks
//      can never silently share a queue again.
//   2. Database seal: before the worker starts we seal/verify
//      `deployment_environment` in the connected database. A mismatch
//      between TELLUS_ENVIRONMENT_ID and the seal REFUSES worker startup
//      (throws FunnelExecutionEnvironmentMismatch — the caller logs a
//      prominent fatal; /health/ready's temporal probe also flips red).
//   3. Namespace: verified to exist before the worker polls. Local/verify
//      stacks provision idempotently; strict mode requires it to exist
//      (provision via deployment infra) unless
//      TELLUS_TEMPORAL_PROVISION_NAMESPACE=1 is set deliberately.
//   4. Poller attribution: the Worker identity string is
//      `<envId>:<buildId>:<pid>@<host>` so task-queue poller audits can
//      reject foreign environments (see scripts/verify-temporal-pollers.*).
//
// If Temporal is unreachable the worker simply does not start and the
// PG-backed funnelDispatcher stays as the fallback — the two pipelines are
// interchangeable at the activity boundary, so there is no duplicate-work
// hazard.
// ---------------------------------------------------------------------------

import { NativeConnection, Worker } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import * as activities from "./activities";
import * as pipelineActivities from "../../pipelines/temporal/activities";
import * as tableImportActivities from "../../connectivity/imports/temporal/activities";
import type { SignalPayload } from "./workflows";
import {
  getEnvironmentIdentity,
  identityLogFields,
  type EnvironmentIdentity,
} from "../../../config/environmentIdentity";
import { sealDatabaseEnvironment } from "../environmentGuard";
import {
  resolveWorkerVersioningConfig,
  versionedWorkerOptions,
} from "./versioning";

let workerInstance: Worker | null = null;
let temporalClient: Client | null = null;
let workerIdentitySnapshot: EnvironmentIdentity | null = null;
let workerDatabaseEnvironmentId: string | null = null;
let workerVersioningSnapshot: import("./versioning").WorkerVersioningConfig | null = null;

// ---------------------------------------------------------------------------
// Workflow identity
// ---------------------------------------------------------------------------

/**
 * Canonical Temporal workflow id for an Object Type's long-running parent
 * workflow, keyed on STABLE resource identifiers — NOT the mutable API name:
 *   `ObjectTypeFunnelWorkflow/<ontologyRid>/<objectTypeRid>`
 * A rename of the Object Type no longer orphans the workflow, and two
 * databases can never address the same workflow through a shared api name
 * (api names are scope-local; RIDs are globally unique).
 */
export function funnelWorkflowId(ontologyRid: string, objectTypeRid: string): string {
  return `ObjectTypeFunnelWorkflow/${ontologyRid}/${objectTypeRid}`;
}

/**
 * LEGACY (pre-FUNN-ISO) api-name-keyed workflow id. Retained ONLY for the
 * migration window: the isolation-migration script terminates these, and
 * `sweepViaTemporalVisibility` still recognizes orphaned runs created by
 * them. New dispatches MUST use {@link funnelWorkflowId}.
 */
export function legacyFunnelWorkflowId(objectTypeApiName: string): string {
  return `ObjectTypeFunnelWorkflow-${objectTypeApiName}`;
}

/** Custom search attributes registered by the provisioning scripts. */
export const FUNNEL_SEARCH_ATTRIBUTES = {
  environmentId: "TellusEnvironmentId",
  ontologyRid: "TellusOntologyRid",
  objectTypeRid: "TellusObjectTypeRid",
  buildId: "TellusWorkerBuildId",
} as const;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function tryConnect(
  address: string
): Promise<{ native: NativeConnection; client: Connection } | null> {
  try {
    const native = await NativeConnection.connect({ address });
    const client = await Connection.connect({ address });
    return { native, client };
  } catch (err) {
    console.warn(
      `[temporal] could not connect to ${address}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Verify (and in local/verify mode, idempotently provision) the namespace.
 * Strict mode REQUIRES the namespace to already exist — provisioning in
 * production-like environments belongs to deployment infrastructure;
 * `TELLUS_TEMPORAL_PROVISION_NAMESPACE=1` is the deliberate opt-out.
 */
async function ensureNamespace(
  connection: Connection,
  identity: EnvironmentIdentity
): Promise<void> {
  const ns = identity.temporalNamespace;
  let exists = false;
  try {
    await connection.workflowService.describeNamespace({ namespace: ns });
    exists = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!/not.?found|NOT_FOUND/i.test(msg)) {
      throw new Error(`describeNamespace(${ns}) failed: ${msg}`);
    }
  }
  if (exists) return;

  const allowAutoProvision =
    identity.mode !== "strict" ||
    process.env.TELLUS_TEMPORAL_PROVISION_NAMESPACE === "1";
  if (!allowAutoProvision) {
    throw new Error(
      `Temporal namespace '${ns}' does not exist and strict mode forbids ` +
        `worker-side provisioning. Create it via deployment infrastructure, ` +
        `e.g.: temporal operator namespace create --address ${identity.temporalAddress} ` +
        `--retention 72h ${ns} — or set TELLUS_TEMPORAL_PROVISION_NAMESPACE=1.`,
    );
  }
  const retentionDays = Number(process.env.TEMPORAL_NAMESPACE_RETENTION_DAYS ?? 3);
  await connection.workflowService.registerNamespace({
    namespace: ns,
    workflowExecutionRetentionPeriod: {
      seconds: retentionDays * 86400 as never,
    },
  });
  console.log(
    JSON.stringify({
      level: "info",
      type: "temporal_namespace_provisioned",
      namespace: ns,
      retentionDays,
      ...identityLogFields(identity),
    })
  );

  // Best-effort: register the funnel lineage search attributes for this
  // namespace so dispatch can attach typed attributes (not just memo).
  // operatorService.addSearchAttributes is idempotent about *values* —
  // re-adding an existing attribute errors with AlreadyExists which we
  // tolerate. Clusters without operator permissions still dispatch fine
  // via the memo-only fallback in signalTemporalWorkflow.
  try {
    // temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD = 2.
    // Hard-coded to avoid a direct @temporalio/api dependency (the client
    // package bundles the same proto).
    const INDEXED_VALUE_TYPE_KEYWORD = 2;
    const searchAttributes: Record<string, number> = {};
    for (const name of Object.values(FUNNEL_SEARCH_ATTRIBUTES)) {
      searchAttributes[name] = INDEXED_VALUE_TYPE_KEYWORD;
    }
    await connection.operatorService.addSearchAttributes({
      namespace: ns,
      searchAttributes,
    } as never);
    console.log(
      JSON.stringify({
        level: "info",
        type: "temporal_search_attributes_registered",
        namespace: ns,
        attributes: Object.keys(searchAttributes),
      }),
    );
  } catch (err) {
    // Already-registered or insufficient privileges — memo fallback covers us.
    console.warn(
      `[temporal] search-attribute registration best-effort failed for ${ns}: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// startTemporalWorker
// ---------------------------------------------------------------------------

export async function startTemporalWorker(): Promise<boolean> {
  // Throws DeploymentConfigurationError in strict mode when identity
  // fields are absent — startup MUST fail loudly, not fall back to a
  // shared default (that default was the split-brain).
  const identity = getEnvironmentIdentity();

  const conn = await tryConnect(identity.temporalAddress);
  if (!conn) return false;

  // Namespace gate — refuses to poll a namespace that doesn't exist.
  await ensureNamespace(conn.client, identity);

  // Database seal gate — refuses to attach this deployment's queue to a
  // database sealed by a DIFFERENT environment.
  let dbEnvironmentId: string;
  try {
    dbEnvironmentId = await sealDatabaseEnvironment(identity);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        type: "temporal_worker_refused_environment_mismatch",
        error: (err as Error).message,
        ...identityLogFields(identity),
      })
    );
    throw err;
  }

  let routingProvisioned = false;
  try {
    const versioning = resolveWorkerVersioningConfig(identity);
    workerInstance = await Worker.create({
      connection: conn.native,
      namespace: identity.temporalNamespace,
      taskQueue: identity.temporalTaskQueue,
      identity: identity.workerIdentity,
      // Temporal-supported Worker Versioning (SDK @deprecated legacy API,
      // functional on server 1.25): poll as this build; routing assigned by
      // the queue's build-id rules (scripts/provision-task-queue-versioning).
      ...versionedWorkerOptions(versioning),
      // PB-B4 follow-3.1 — register both the Funnel's own workflows
      // and the Pipeline-Builder workflows under the same worker so
      // pb-b4 iceberg maintenance runs on the existing task queue.
      workflowsPath: require.resolve("./workflowsBundle"),
      activities: { ...activities, ...pipelineActivities, ...tableImportActivities },
      maxConcurrentActivityTaskExecutions: 20,
      maxConcurrentWorkflowTaskExecutions: 10,
    });
    temporalClient = new Client({
      connection: conn.client,
      namespace: identity.temporalNamespace,
      identity: identity.workerIdentity,
    });
    workerIdentitySnapshot = identity;
    workerDatabaseEnvironmentId = dbEnvironmentId;
    workerVersioningSnapshot = versioning;
    // Queue routing self-provisioning: with build-ID versioning enabled, an
    // unrouted queue strands every dispatched workflow ("baseline" probe
    // evidence). APIs must boot with routing in place. Strict mode: infra
    // owns the rule (failure = boot error, surfacing platform misconfig).
    if (versioning.enabled) {
      const { ensureQueueAssignmentRule } = await import("./versioning");
      const route = await ensureQueueAssignmentRule(conn.client as never, {
        namespace: identity.temporalNamespace,
        taskQueue: identity.temporalTaskQueue,
        buildId: versioning.buildId,
        strict: identity.mode === "strict",
      });
      routingProvisioned = route.provisioned;
    }
    void workerInstance.run().catch(async (err) => {
      console.error(`[temporal] worker run failed: ${(err as Error).message}`);
      try {
        const { recordTemporalFailure } = await import(
          "../../pipelines/metrics"
        );
        recordTemporalFailure(
          "worker",
          (err as Error).name ?? "unknown",
        );
      } catch {
        /* ignore */
      }
    });
    console.log(
      JSON.stringify({
        level: "info",
        type: "temporal_worker_started",
        dbEnvironmentId,
        versioningEnabled: versioning.enabled,
        buildId: versioning.buildId,
        deploymentName: versioning.deploymentName,
        routingProvisioned,
        ...identityLogFields(identity),
      })
    );
    return true;
  } catch (err) {
    console.warn(`[temporal] worker bootstrap failed: ${(err as Error).message}`);
    return false;
  }
}

export async function stopTemporalWorker(): Promise<void> {
  if (workerInstance) {
    try {
      workerInstance.shutdown();
    } catch {
      /* ignore */
    }
    workerInstance = null;
  }
  temporalClient = null;
  workerIdentitySnapshot = null;
  workerDatabaseEnvironmentId = null;
  workerVersioningSnapshot = null;
}

// ---------------------------------------------------------------------------
// Workflow dispatch (durable hand-off — FUNN-ISO-6)
// ---------------------------------------------------------------------------

/** Lineage memo attached to every funnel workflow start. */
export interface FunnelWorkflowMemo {
  environmentId: string;
  ontologyRid: string;
  objectTypeRid: string;
  objectTypeApiName: string;
  funnelRunId?: string;
  dbEnvironmentId?: string;
  workerBuildId: string;
  datasourceId?: string;
  actor?: string;
  reason?: string;
  sourceTransactionId?: string;
}

export interface SignalDispatchInput {
  ontologyId: string;
  objectTypeApiName: string;
  objectTypeRid: string;
  signalType:
    | "sourceTransactionCommitted"
    | "editBatchPending"
    | "schemaChanged"
    | "pipelineDeployCompleted";
  payload?: SignalPayload;
  /** Extra memo fields (datasourceId/actor/reason/sourceTransactionId). */
  memo?: Partial<FunnelWorkflowMemo>;
}

/**
 * Start (or signal) the RID-keyed long-running ObjectTypeFunnelWorkflow.
 * Idempotent: the workflow id is deterministic per (ontologyRid, rid), and
 * `USE_EXISTING` turns a concurrent duplicate dispatch into a plain signal.
 *
 * Lineage: the full context is placed in the workflow memo (always works)
 * plus typed search attributes when provisioned — on clusters without the
 * custom attributes registered, we retry memo-only rather than failing the
 * dispatch ( degrade lineage, never delivery).
 */
export async function signalTemporalWorkflow(
  input: SignalDispatchInput
): Promise<boolean> {
  if (!temporalClient) return false;
  const identity = workerIdentitySnapshot ?? getEnvironmentIdentity();
  const workflowId = funnelWorkflowId(input.ontologyId, input.objectTypeRid);

  // FUNN-ISO-3: first-dispatch gate — never let a signal start the OT's
  // parent workflow BEFORE the queue's assignment rule exists, or the
  // workflow is stamped unversioned and can never be claimed by versioned
  // pollers. Wait (bounded); the outbox CAS retries otherwise.
  {
    const { waitForQueueRule } = await import("./versioning");
    await waitForQueueRule(
      temporalClient.connection as never,
      identity.temporalNamespace,
      identity.temporalTaskQueue,
    );
  }

  // Conflict policy — prod-safe default `USE_EXISTING` keeps the "one
  // long-running parent workflow per OT" invariant. Opt-in
  // `FUNNEL_TERMINATE_ON_SAVE=true` makes every save forcibly replace an
  // in-flight workflow (the verify-funnel-reset semantic). Before
  // terminating we give the workflow up to FUNNEL_CANCEL_TIMEOUT_MS
  // (default 30s) to exit gracefully via cancel.
  const terminateOnSave = process.env.FUNNEL_TERMINATE_ON_SAVE === "true";
  if (terminateOnSave) {
    await cancelWithTimeoutIfStuck(workflowId);
    incrementCounter("funnel_workflow_terminate_on_save_total", {
      object_type: input.objectTypeApiName,
    });
  }

  const memo: FunnelWorkflowMemo = {
    environmentId: identity.environmentId,
    ontologyRid: input.ontologyId,
    objectTypeRid: input.objectTypeRid,
    objectTypeApiName: input.objectTypeApiName,
    funnelRunId: input.payload?.funnelRunId,
    dbEnvironmentId: workerDatabaseEnvironmentId ?? undefined,
    workerBuildId: identity.workerBuildId,
    ...input.memo,
  };

  const continueAsNewThresholdRaw =
    process.env.FUNNEL_WORKFLOW_CONTINUE_AS_NEW_THRESHOLD;
  const continueAsNewThresholdParsed = continueAsNewThresholdRaw
    ? Number(continueAsNewThresholdRaw)
    : NaN;
  const continueAsNewThreshold =
    Number.isFinite(continueAsNewThresholdParsed) &&
    continueAsNewThresholdParsed > 0
      ? Math.floor(continueAsNewThresholdParsed)
      : undefined;

  const workflowArgs = [
    {
      ontologyId: input.ontologyId,
      objectTypeApiName: input.objectTypeApiName,
      objectTypeRid: input.objectTypeRid,
      environmentId: identity.environmentId,
      continueAsNewThreshold,
    },
  ];

  const searchAttributes = {
    [FUNNEL_SEARCH_ATTRIBUTES.environmentId]: [identity.environmentId],
    [FUNNEL_SEARCH_ATTRIBUTES.ontologyRid]: [input.ontologyId],
    [FUNNEL_SEARCH_ATTRIBUTES.objectTypeRid]: [input.objectTypeRid],
    [FUNNEL_SEARCH_ATTRIBUTES.buildId]: [identity.workerBuildId],
  };

  try {
    try {
      await temporalClient.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
        workflowId,
        taskQueue: identity.temporalTaskQueue,
        args: workflowArgs,
        signal: input.signalType,
        signalArgs: [input.payload ?? {}],
        memo: { ...memo },
        searchAttributes,
        // eslint-plugin note: keep this pattern single-line —
        // scripts/test-production-readiness.sh greps for it literally.
        workflowIdConflictPolicy: terminateOnSave ? "TERMINATE_EXISTING" : "USE_EXISTING",
      });
    } catch (err) {
      // Clusters without the custom search attributes registered reject the
      // start — retry memo-only so dispatch itself is never blocked by a
      // metadata-registration gap. The "search attribute" complaint is in
      // the gRPC CAUSE chain, not the envelope message, so walk it.
      let isSearchAttrErr = false;
      let cur = err as { message?: string; cause?: unknown } | undefined;
      let depth = 0;
      while (cur && depth < 8) {
        if (/search.?attribute/i.test(cur.message ?? "")) {
          isSearchAttrErr = true;
          break;
        }
        cur = cur.cause as typeof cur;
        depth++;
      }
      if (!isSearchAttrErr) throw err;
      await temporalClient.workflow.signalWithStart("ObjectTypeFunnelWorkflow", {
        workflowId,
        taskQueue: identity.temporalTaskQueue,
        args: workflowArgs,
        signal: input.signalType,
        signalArgs: [input.payload ?? {}],
        memo: { ...memo },
        workflowIdConflictPolicy: terminateOnSave ? "TERMINATE_EXISTING" : "USE_EXISTING",
      });
    }
    incrementCounter("funnel_signal_with_start_total", {
      environment: identity.environmentId,
      object_type: input.objectTypeApiName,
      signal_type: input.signalType,
    });
    return true;
  } catch (err) {
    incrementCounter("funnel_signal_with_start_errors_total", {
      environment: identity.environmentId,
      object_type: input.objectTypeApiName,
    });
    // Unwrap the Temporal cause chain — "Failed to signalWithStart Workflow"
    // is the envelope; the REAL cause (notfound/validation/…) sits in .cause.
    let causeMsg = "";
    let cur = err as { cause?: unknown } | undefined;
    let depth = 0;
    while (cur?.cause && depth < 8) {
      const c = cur.cause as { message?: string; details?: string };
      if (c?.message) causeMsg += ` | cause: ${c.details ?? c.message}`;
      cur = cur.cause as typeof cur;
      depth++;
    }
    console.warn(
      `[temporal] signalWithStart failed for ${input.objectTypeApiName}: ${(err as Error).message}${causeMsg}`
    );
    return false;
  }
}

/**
 * Graceful-replace pattern: if the workflow is running and older than
 * FUNNEL_CANCEL_STALE_THRESHOLD_MS (default 2 min), send cancel, wait up to
 * FUNNEL_CANCEL_TIMEOUT_MS (default 30s) for a clean exit, then let the
 * caller's signalWithStart(TERMINATE_EXISTING) finish the job.
 */
async function cancelWithTimeoutIfStuck(workflowId: string): Promise<void> {
  if (!temporalClient) return;
  const staleMs = Number(process.env.FUNNEL_CANCEL_STALE_THRESHOLD_MS ?? 2 * 60 * 1000);
  const timeoutMs = Number(process.env.FUNNEL_CANCEL_TIMEOUT_MS ?? 30_000);
  try {
    const handle = temporalClient.workflow.getHandle(workflowId);
    const desc = await handle.describe();
    if (desc.status.name !== "RUNNING") return;
    const ageMs = Date.now() - desc.startTime.getTime();
    if (ageMs < staleMs) return;
    incrementCounter("funnel_workflow_cancel_attempted_total", {
      object_type: workflowId.replace(/^ObjectTypeFunnelWorkflow[-/]/, ""),
    });
    await handle.cancel();
    const giveUpAt = Date.now() + timeoutMs;
    while (Date.now() < giveUpAt) {
      await new Promise((r) => setTimeout(r, 500));
      const now = await handle.describe();
      if (now.status.name !== "RUNNING") {
        incrementCounter("funnel_workflow_cancelled_cleanly_total", {});
        return;
      }
    }
    incrementCounter("funnel_workflow_cancel_timeout_total", {});
  } catch (err) {
    const msg = (err as Error).message;
    if (!/not found/i.test(msg) && !/NotFound/i.test(msg)) {
      console.warn(
        `[temporal] cancelWithTimeoutIfStuck(${workflowId}): ${msg}`
      );
    }
  }
}

/** Internal metrics handle. */
function incrementCounter(name: string, labels: Record<string, string>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("../metrics") as typeof import("../metrics");
    m.incCounter(name, labels);
  } catch {
    /* metrics module not loaded — no-op */
  }
}

/**
 * Terminate the durable parent workflow for an Object Type (called when the
 * type is DELETED). Terminates BOTH the RID-keyed id and — during the
 * migration window — the legacy api-name-keyed id.
 */
export async function terminateTemporalWorkflow(
  objectTypeApiName: string,
  reason: string = "object type deleted",
  identity?: { ontologyId?: string; objectTypeRid?: string }
): Promise<boolean> {
  if (!temporalClient) return false;
  const ids = [legacyFunnelWorkflowId(objectTypeApiName)];
  if (identity?.ontologyId && identity?.objectTypeRid) {
    ids.unshift(funnelWorkflowId(identity.ontologyId, identity.objectTypeRid));
  }
  let anyTerminated = false;
  for (const workflowId of ids) {
    try {
      await temporalClient.workflow.getHandle(workflowId).terminate(reason);
      anyTerminated = true;
      incrementCounter("funnel_workflow_terminated_total", {
        object_type: objectTypeApiName,
        workflow_id_kind: workflowId.includes("/") ? "rid" : "legacy",
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (!/not found/i.test(msg) && !/NotFound/i.test(msg)) {
        console.warn(
          `[temporal] terminate failed for ${workflowId}: ${msg}`
        );
      }
    }
  }
  return anyTerminated;
}

/** Internal accessor used by the sweeper. Null when Temporal isn't connected. */
export function getTemporalClient(): Client | null {
  return temporalClient;
}

export function isTemporalConnected(): boolean {
  return temporalClient != null && workerInstance != null;
}

/** Diagnostics snapshot used by /health/ready + ops tooling. */
export function getWorkerDiagnostics(): {
  connected: boolean;
  identity: EnvironmentIdentity | null;
  dbEnvironmentId: string | null;
  versioning: import("./versioning").WorkerVersioningConfig | null;
} {
  return {
    connected: isTemporalConnected(),
    identity: workerIdentitySnapshot,
    dbEnvironmentId: workerDatabaseEnvironmentId,
    versioning: workerVersioningSnapshot,
  };
}
