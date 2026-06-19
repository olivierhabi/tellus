// ---------------------------------------------------------------------------
// B4 — BullMQ runtime (spec §B4 line 194).
//
// Default WorkerRuntimeAdapter. Enqueues each JobSpec onto a per-tenant
// BullMQ queue, and runs a Worker that delegates to the child_process
// sandbox. The sandbox is the actual user-code container; BullMQ is purely
// the scheduling + retry layer.
//
// Redis is required. If `bullmq` and `ioredis` are not installed (e.g. the
// test profile), the adapter falls back to an in-memory shim that still
// satisfies the WorkerRuntimeAdapter contract (so unit tests can exercise
// the orchestration service without standing up Redis).
// ---------------------------------------------------------------------------

import type {
  WorkerRuntimeAdapter,
  JobSpec,
  RuntimeEvent,
} from "./runtime-adapter";
import { spawnSandbox, type SandboxHandle } from "./child-process-sandbox";

const QUEUE_NAME = process.env.TELLUS_BUILD_QUEUE ?? "tellus-builds";

interface BullmqDeps {
  Queue: typeof import("bullmq").Queue;
  Worker: typeof import("bullmq").Worker;
  QueueEvents: typeof import("bullmq").QueueEvents;
}

async function tryLoadBullmq(): Promise<BullmqDeps | null> {
  try {
    const mod = (await import("bullmq")) as unknown as BullmqDeps;
    return mod;
  } catch {
    return null;
  }
}

export async function createBullmqRuntime(): Promise<WorkerRuntimeAdapter> {
  const bullmq = await tryLoadBullmq();
  if (!bullmq) {
    return createInMemoryRuntime();
  }
  return createRealBullmqRuntime(bullmq);
}

// ---------------------------------------------------------------------------
// Real BullMQ runtime.
// ---------------------------------------------------------------------------
function createRealBullmqRuntime(bm: BullmqDeps): WorkerRuntimeAdapter {
  const connection = {
    host: process.env.TELLUS_REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.TELLUS_REDIS_PORT ?? 6379),
  };
  const queue = new bm.Queue(QUEUE_NAME, { connection });
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const inflight = new Map<string, SandboxHandle>();

  const worker = new bm.Worker(
    QUEUE_NAME,
    async (job) => {
      const spec = job.data as JobSpec;
      const handle = spawnSandbox(spec, (e) =>
        listeners.forEach((l) => l(e)),
      );
      inflight.set(spec.buildRid, handle);
      // Soft deadline.
      const deadlineTimer = setTimeout(
        () => handle.kill("SIGKILL"),
        spec.deadlineMs,
      );
      const result = await handle.exit;
      clearTimeout(deadlineTimer);
      inflight.delete(spec.buildRid);
      const status =
        result.code === 0
          ? "succeeded"
          : result.signal === "SIGKILL"
            ? "timeout"
            : "failed";
      listeners.forEach((l) =>
        l({
          buildRid: spec.buildRid,
          ts: new Date().toISOString(),
          kind: status === "succeeded" ? "succeeded" : "failed",
          data: { exitCode: result.code, signal: result.signal },
        }),
      );
      if (status !== "succeeded") {
        throw new Error(
          `worker terminated abnormally: code=${result.code} signal=${result.signal}`,
        );
      }
    },
    { connection, concurrency: Number(process.env.TELLUS_WORKER_CONCURRENCY ?? 2) },
  );

  return {
    async submit(spec: JobSpec) {
      await queue.add(spec.buildRid, spec, {
        jobId: spec.buildRid,
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      });
    },
    async cancel(buildRid: string) {
      const handle = inflight.get(buildRid);
      if (handle) handle.kill("SIGTERM");
      const job = await queue.getJob(buildRid);
      if (job) await job.remove();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async shutdown() {
      for (const handle of inflight.values()) handle.kill("SIGTERM");
      await worker.close();
      await queue.close();
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback used when bullmq/ioredis aren't installed (unit tests).
// Preserves observable behaviour but executes inline + immediately.
// ---------------------------------------------------------------------------
function createInMemoryRuntime(): WorkerRuntimeAdapter {
  const listeners = new Set<(e: RuntimeEvent) => void>();
  const inflight = new Map<string, SandboxHandle>();
  return {
    async submit(spec: JobSpec) {
      const handle = spawnSandbox(spec, (e) =>
        listeners.forEach((l) => l(e)),
      );
      inflight.set(spec.buildRid, handle);
      const deadlineTimer = setTimeout(
        () => handle.kill("SIGKILL"),
        spec.deadlineMs,
      );
      void handle.exit.then((res) => {
        clearTimeout(deadlineTimer);
        inflight.delete(spec.buildRid);
        const status =
          res.code === 0
            ? "succeeded"
            : res.signal === "SIGKILL"
              ? "timeout"
              : "failed";
        listeners.forEach((l) =>
          l({
            buildRid: spec.buildRid,
            ts: new Date().toISOString(),
            kind: status === "succeeded" ? "succeeded" : "failed",
            data: { exitCode: res.code, signal: res.signal },
          }),
        );
      });
    },
    async cancel(buildRid: string) {
      const handle = inflight.get(buildRid);
      if (handle) handle.kill("SIGTERM");
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async shutdown() {
      for (const handle of inflight.values()) handle.kill("SIGTERM");
    },
  };
}
