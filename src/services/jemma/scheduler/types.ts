// ---------------------------------------------------------------------------
// B6 — Worker adapter + scheduler types.
//
// The scheduler is decoupled from the actual pod runtime via a WorkerAdapter
// interface. Production wires a Kubernetes adapter; tests wire an in-memory
// adapter. The scheduler is single-source-of-truth on QUEUED→RUNNING admission
// and per-(repo,ref) singleton cancellation.
// ---------------------------------------------------------------------------

import type { RunRow } from "../store/runStore";
import type { FailureReason } from "../state/types";

/**
 * Adapter to the worker runtime (k8s in production; in-memory for tests).
 * The scheduler calls these methods; never reads them.
 */
export interface WorkerAdapter {
  /**
   * Start a worker pod for a run. Returns the pod name on success; throws
   * with kind="image-unavailable" if the worker image cannot be pulled.
   */
  startPod(args: { runRid: string; repositoryRid: string; commitSha: string }): Promise<{
    podName: string;
  }>;

  /**
   * Send a graceful cancel signal to a running pod. Implementations should
   * SIGTERM and wait up to 30s before SIGKILL. The pod's eventual exit is
   * surfaced via observeProgress (state=FAILED|CANCELLED).
   */
  signalCancel(args: { runRid: string; podName: string; reason: FailureReason }): Promise<void>;
}

/**
 * Outcome of `scheduleRun` — what the caller (HTTP route) returns to the
 * client. `existing` is set when an idempotent replay matched.
 */
export type ScheduleOutcome =
  | { kind: "started";   run: RunRow; cancelledRid: string | null }
  | { kind: "queued";    run: RunRow }
  | { kind: "replay";    run: RunRow }
  | { kind: "capacity-exceeded"; reason: "per-repo-cap" | "global-pool" }
  | { kind: "image-unavailable" };

export interface SchedulerConfig {
  /** Per-repo concurrency cap. Default 4 per spec §B6. */
  readonly perRepoActiveCap: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  perRepoActiveCap: 4,
};
