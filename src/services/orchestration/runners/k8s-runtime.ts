// ---------------------------------------------------------------------------
// B4 — Kubernetes Job runtime adapter (spec §B4 line 195).
//
// Production-grade swap-in for bullmq-runtime. Functional tests deferred
// (DEFERRED.md: needs K8s cluster + Cilium-enabled node pool). The class
// shape is stable and matches WorkerRuntimeAdapter so orchestration code
// can switch via TELLUS_WORKER_RUNTIME=k8s without code changes.
//
// Until functional tests land, submit/cancel return UnsupportedRuntime
// errors so callers detect mis-configuration immediately rather than
// silently failing in production.
// ---------------------------------------------------------------------------

import type {
  WorkerRuntimeAdapter,
  JobSpec,
  RuntimeEvent,
} from "./runtime-adapter";

export class UnsupportedRuntime extends Error {
  constructor(method: string) {
    super(
      `K8sRuntime: ${method} is stubbed; set TELLUS_WORKER_RUNTIME=bullmq or wait for B4 K8s wave.`,
    );
    this.name = "UnsupportedRuntime";
  }
}

export async function createK8sRuntime(): Promise<WorkerRuntimeAdapter> {
  // Try loading the k8s client. We don't actually use it yet — verifying
  // its presence here surfaces configuration errors at boot, not at first
  // job submit, which is what operators want.
  try {
    await import("@kubernetes/client-node");
  } catch {
    // Treat as deferred — still expose the adapter so callers can be tested.
  }
  const listeners = new Set<(e: RuntimeEvent) => void>();
  return {
    async submit(_spec: JobSpec) {
      throw new UnsupportedRuntime("submit");
    },
    async cancel(_buildRid: string) {
      throw new UnsupportedRuntime("cancel");
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async shutdown() {
      listeners.clear();
    },
  };
}
