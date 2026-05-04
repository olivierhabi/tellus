// ---------------------------------------------------------------------------
// B6 — In-memory worker adapter for tests.
// ---------------------------------------------------------------------------

import type { WorkerAdapter } from "./types";

export class InMemoryWorker implements WorkerAdapter {
  private startCalls: Array<{ runRid: string; repositoryRid: string; commitSha: string }> = [];
  private cancelCalls: Array<{ runRid: string; podName: string; reason: string }> = [];
  private nextPodId = 0;
  private failNext: { kind: "image-unavailable" } | null = null;
  private cancelDelayMs = 0;

  /** Configure the next startPod() call to throw image-unavailable. */
  failStartWithImageUnavailable(): void {
    this.failNext = { kind: "image-unavailable" };
  }

  /** Configure all signalCancel() calls to await this many ms before resolving. */
  setCancelDelay(ms: number): void {
    this.cancelDelayMs = ms;
  }

  async startPod(args: {
    runRid: string;
    repositoryRid: string;
    commitSha: string;
  }): Promise<{ podName: string }> {
    if (this.failNext?.kind === "image-unavailable") {
      this.failNext = null;
      const e = new Error("image-unavailable");
      (e as { kind?: string }).kind = "image-unavailable";
      throw e;
    }
    this.startCalls.push({ ...args });
    const podName = `pod-${this.nextPodId++}-${args.runRid.slice(-8)}`;
    return { podName };
  }

  async signalCancel(args: { runRid: string; podName: string; reason: string }): Promise<void> {
    this.cancelCalls.push({ ...args });
    if (this.cancelDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.cancelDelayMs));
    }
  }

  // -------------------------------------------------------------------------
  // Test introspection.
  // -------------------------------------------------------------------------

  observed(): {
    starts: ReadonlyArray<{ runRid: string; repositoryRid: string; commitSha: string }>;
    cancels: ReadonlyArray<{ runRid: string; podName: string; reason: string }>;
  } {
    return { starts: [...this.startCalls], cancels: [...this.cancelCalls] };
  }

  reset(): void {
    this.startCalls = [];
    this.cancelCalls = [];
    this.failNext = null;
    this.nextPodId = 0;
    this.cancelDelayMs = 0;
  }
}
