// ---------------------------------------------------------------------------
// B4 — Kubernetes Job runtime adapter (spec §B4 line 195).
//
// Production WorkerRuntimeAdapter: dispatches each JobSpec as a Kubernetes Job
// pinned to the gVisor (`runsc`) RuntimeClass, with a hardened pod security
// context and a default-deny-egress NetworkPolicy. This is the FOUNDRY-GAPS §1
// "safe execution of user-authored code" wiring — the import-strategy worker
// (the real user-code surface) now runs inside a gVisor-isolated kernel rather
// than a host-shared child process. The substrate is verified in
// deploy/substrate/verify-substrate.sh (§3).
//
// Select with TELLUS_WORKER_RUNTIME=k8s. The bullmq runtime stays the default
// for single-host / dev. Manifest construction lives in k8s-manifests.ts (pure,
// unit-tested); this module is the client + lifecycle glue.
// ---------------------------------------------------------------------------

import type {
  WorkerRuntimeAdapter,
  JobSpec,
  RuntimeEvent,
} from "./runtime-adapter";
import {
  buildJobManifest,
  buildEgressNetworkPolicy,
  classifyJobStatus,
  jobName,
  k8sRuntimeOptionsFromEnv,
  type K8sRuntimeOptions,
} from "./k8s-manifests";

export class K8sRuntimeUnavailable extends Error {
  constructor(detail: string) {
    super(
      `K8sRuntime: ${detail}. Install @kubernetes/client-node and run in a cluster, or set TELLUS_WORKER_RUNTIME=bullmq.`,
    );
    this.name = "K8sRuntimeUnavailable";
  }
}

interface K8sClient {
  batch: {
    createNamespacedJob(ns: string, body: unknown): Promise<{ body: unknown }>;
    readNamespacedJobStatus(
      name: string,
      ns: string,
    ): Promise<{ body: unknown }>;
    deleteNamespacedJob(name: string, ns: string): Promise<unknown>;
  };
  net: {
    createNamespacedNetworkPolicy(
      ns: string,
      body: unknown,
    ): Promise<{ body: unknown }>;
    deleteNamespacedNetworkPolicy(name: string, ns: string): Promise<unknown>;
  };
}

async function loadK8sClient(): Promise<K8sClient> {
  let mod: typeof import("@kubernetes/client-node");
  try {
    mod = await import("@kubernetes/client-node");
  } catch {
    throw new K8sRuntimeUnavailable("@kubernetes/client-node is not installed");
  }
  const kc = new mod.KubeConfig();
  // In-cluster first (the production case: mounted SA + CA); fall back to the
  // local kubeconfig for operator-run smoke tests against a dev cluster.
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return {
    batch: kc.makeApiClient(mod.BatchV1Api),
    net: kc.makeApiClient(mod.NetworkingV1Api),
  };
}

const POLL_INTERVAL_MS = Number(process.env.TELLUS_K8S_POLL_MS ?? "3000");

export async function createK8sRuntime(
  optsOverride?: Partial<K8sRuntimeOptions>,
): Promise<WorkerRuntimeAdapter> {
  const opts = { ...k8sRuntimeOptionsFromEnv(), ...optsOverride };
  const client = await loadK8sClient();
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const pollers = new Map<string, ReturnType<typeof setInterval>>();
  const emit = (e: RuntimeEvent) => listeners.forEach((l) => l(e));

  const now = () => new Date().toISOString();

  function watchJob(spec: JobSpec): void {
    const name = jobName(spec.buildRid);
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await client.batch.readNamespacedJobStatus(
            name,
            opts.namespace,
          );
          const status =
            ((res.body as { status?: unknown })?.status as Parameters<
              typeof classifyJobStatus
            >[0]) ?? {};
          const outcome = classifyJobStatus(status);
          if (!outcome) return; // still running
          stopWatch(spec.buildRid);
          emit({
            buildRid: spec.buildRid,
            ts: now(),
            kind: outcome.kind === "succeeded" ? "succeeded" : "failed",
            data: { status: outcome.kind, reason: outcome.reason },
          });
          // The Job's ttlSecondsAfterFinished reaps the pod; the NetworkPolicy
          // is cleaned up best-effort here.
          void client.net
            .deleteNamespacedNetworkPolicy(`${name}-egress`, opts.namespace)
            .catch(() => undefined);
        } catch (err) {
          // Transient API errors: keep polling. A 404 means the Job is gone
          // (TTL-reaped or cancelled) — stop and report cancelled.
          if (isNotFound(err)) {
            stopWatch(spec.buildRid);
            emit({
              buildRid: spec.buildRid,
              ts: now(),
              kind: "cancelled",
              data: { reason: "job not found (reaped or cancelled)" },
            });
          }
        }
      })();
    }, POLL_INTERVAL_MS);
    pollers.set(spec.buildRid, timer);
  }

  function stopWatch(buildRid: string): void {
    const t = pollers.get(buildRid);
    if (t) {
      clearInterval(t);
      pollers.delete(buildRid);
    }
  }

  return {
    async submit(spec: JobSpec) {
      const job = buildJobManifest(spec, opts);
      const netpol = buildEgressNetworkPolicy(spec, opts);
      // Apply the egress policy BEFORE the Job so the pod is never schedulable
      // with open egress. Best-effort: a cluster without NetworkPolicy support
      // shouldn't block the build (the in-process allowlist still applies).
      await client.net
        .createNamespacedNetworkPolicy(opts.namespace, netpol)
        .catch((err) => {
          emit({
            buildRid: spec.buildRid,
            ts: now(),
            kind: "log",
            data: {
              stream: "stderr",
              line: `networkpolicy apply failed (continuing): ${(err as Error).message}`,
            },
          });
        });
      await client.batch.createNamespacedJob(opts.namespace, job);
      emit({
        buildRid: spec.buildRid,
        ts: now(),
        kind: "started",
        data: {
          tenant: spec.tenant,
          importRid: spec.importRid,
          job: jobName(spec.buildRid),
          runtimeClass: opts.runtimeClassName,
        },
      });
      watchJob(spec);
    },

    async cancel(buildRid: string) {
      stopWatch(buildRid);
      const name = jobName(buildRid);
      await client.batch
        .deleteNamespacedJob(name, opts.namespace)
        .catch(() => undefined);
      await client.net
        .deleteNamespacedNetworkPolicy(`${name}-egress`, opts.namespace)
        .catch(() => undefined);
      emit({ buildRid, ts: now(), kind: "cancelled" });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async shutdown() {
      for (const t of pollers.values()) clearInterval(t);
      pollers.clear();
      listeners.clear();
    },
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } };
  return (
    e?.statusCode === 404 ||
    e?.response?.statusCode === 404 ||
    e?.body?.code === 404
  );
}
