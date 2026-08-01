#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// replicaWorker — a standalone funnel worker+dispatcher process for the
// multi-replica correctness proofs (FUNN-ISO-7). Boot components:
//   1. deployment seal (fails fast on mismatch — the audit expectation for a
//      worker pointed at a queue whose DB belongs to another environment),
//   2. Temporal funnel worker,
//   3. in-process dispatcher loop (queue dispatch for signal claims).
//
// Env contract (the lane): TELLUS_ENVIRONMENT_ID, PG*, TEMPORAL_*, plus:
//   FUNNEL_STAGE_DELAY_MS        — widen activity windows for deterministic
//                                  "kill during activity" choreography
//   FUNNEL_STAGE_RECEIPT_FILE    — every stage claims one JSONL receipt
//   FUNNEL_STAGE_RECEIPT_LABEL   — attribution tag (replica identifier)
//
// stdout JSON markers: {type:"replica_ready",label,pid,namespace,queue}.
// The process does not get a "boot failed" side channel — boot errors are
// process-fatal (non-zero exit), exactly the way the seal gate behaves.
// ---------------------------------------------------------------------------

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main(): Promise<void> {
  await import("dotenv/config");
  const label = flag("label", `replica-${process.pid}`);
  const interval = Number(flag("dispatcher-interval-ms", "500"));

  const { startTemporalWorker } = await import("../../src/services/funnel/temporal/worker");
  const { startFunnelDispatcher } = await import("../../src/services/funnel/funnelDispatcher");
  const { getEnvironmentIdentity, identityLogFields } = await import("../../src/config/environmentIdentity");

  // startTemporalWorker itself seals the DB → the environment-gate rejects
  // BEFORE any poll (the multi-replica negative case). useVersioning+buildId
  // come from worker.ts; queue routing rules self-provision in local mode.
  const started = await startTemporalWorker();
  if (!started) {
    console.error(JSON.stringify({ type: "replica_tmporal_unreachable", label }));
    process.exit(2);
  }
  startFunnelDispatcher({ intervalMs: interval });

  const id = getEnvironmentIdentity();
  console.log(JSON.stringify({
    type: "replica_ready",
    label,
    pid: process.pid,
    namespace: id.temporalNamespace,
    queue: id.temporalTaskQueue,
    workerIdentity: id.workerIdentity,
    ...identityLogFields(id),
  }));

  // Stay alive indefinitely; the PARENT kills us (that's the experiment).
  await new Promise(() => {});
}

void main().catch((err) => {
  console.error(JSON.stringify({ type: "replica_boot_failed", error: (err as Error).message }));
  process.exit(1);
});
