// ---------------------------------------------------------------------------
// B4 — WorkerRuntimeAdapter (spec §B4 line 193).
//
// Pluggable interface that abstracts "how to actually execute a job" so that
// the default BullMQ + child_process implementation can be swapped for a K8s
// Job adapter in production without changing the orchestration service.
//
// The orchestration service holds exactly one adapter at boot, chosen via
// TELLUS_WORKER_RUNTIME=bullmq|k8s.
// ---------------------------------------------------------------------------

export type WorkerKind = "foundryWorker" | "agentProxy";

export interface JobSpec {
  /** Build RID — Tellus orchestration assigns one per execution attempt. */
  buildRid: string;
  /** Import RID (TableImport / VirtualTable). */
  importRid: string;
  /** Connection RID the import reads from. */
  connectionRid: string;
  /** Tenant for routing and metric labelling. */
  tenant: string;
  /** Caller for audit. Workload JWT subject. */
  actor: string;
  /** Tellus worker kind (legacy agentWorker rejected upstream). */
  kind: WorkerKind;
  /** Egress policy snapshot (host:port pairs or CIDR allowlist). */
  egress: {
    allow: Array<{ host: string; port: number }>;
    cidrs: string[];
  };
  /** Short-lived workload JWT (B2). */
  workloadJwt: string;
  /** Strategy-specific payload (snapshot vs append vs CDC). */
  payload: Record<string, unknown>;
  /** Soft deadline; runtime kills the job past this point. */
  deadlineMs: number;
}

export interface JobOutcome {
  buildRid: string;
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  exitCode: number | null;
  durationMs: number;
  /** Bytes read from the source. */
  bytesRead?: number;
  /** Rows written to Iceberg. */
  rowsWritten?: number;
  /** Iceberg snapshot RID committed (snapshot/append). */
  snapshotRid?: string;
  /** Human-readable failure reason; never plaintext credentials. */
  reason?: string;
}

export interface RuntimeEvent {
  buildRid: string;
  ts: string; // ISO
  kind: "started" | "progress" | "log" | "succeeded" | "failed" | "cancelled";
  data?: Record<string, unknown>;
}

export interface WorkerRuntimeAdapter {
  /** Submit a job for execution. Returns immediately; outcome flows via events. */
  submit(spec: JobSpec): Promise<void>;

  /** Best-effort cancel of an in-flight job. */
  cancel(buildRid: string): Promise<void>;

  /**
   * Subscribe to runtime events. The adapter calls the listener for every
   * lifecycle and progress event. Returns an unsubscribe.
   */
  onEvent(listener: (e: RuntimeEvent) => void): () => void;

  /** Shutdown: drain queues, close child processes. */
  shutdown(): Promise<void>;
}

/** Boot the configured adapter. Reads TELLUS_WORKER_RUNTIME. */
export async function loadRuntimeAdapter(): Promise<WorkerRuntimeAdapter> {
  const which = process.env.TELLUS_WORKER_RUNTIME ?? "bullmq";
  switch (which) {
    case "bullmq": {
      const mod = await import("./bullmq-runtime");
      return mod.createBullmqRuntime();
    }
    case "k8s": {
      const mod = await import("./k8s-runtime");
      return mod.createK8sRuntime();
    }
    default:
      throw new Error(`Unknown TELLUS_WORKER_RUNTIME: ${which}`);
  }
}
