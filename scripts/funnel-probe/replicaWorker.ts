#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// replicaWorker — a standalone funnel worker+dispatcher process for the
// multi-replica correctness proofs (FUNN-ISO-7). Boot components:
//   1. deployment seal (fails fast on mismatch — the audit expectation for a
//      worker pointed at a queue whose DB belongs to another environment),
//   2. Temporal funnel worker,
//   3. in-process dispatcher loop (queue dispatch for signal claims,
//      optionally scoped to a stamped set of object types so a shared
//      test-lane queue can't shift-test fixtures into the wrong replica).
//
// stdout JSON markers: {type:"replica_ready",label,pid,namespace,queue}.
// Boot errors are process-fatal (non-zero exit) — matching the seal gate.
// ---------------------------------------------------------------------------

function flag(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

async function main(): Promise<void> {
  // dotenv-loaded with an EXPLICIT path (custom spawn-CWD-safe).
  const dotenvMod = (await import("dotenv")).default;
  const url = new URL("../../.env", import.meta.url).pathname;
  dotenvMod.config({ path: url });
  const label = flag("label", `replica-${process.pid}`);
  const interval = Number(flag("dispatcher-interval-ms", "500"));
  const objectTypes = flag("object-types", "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const { startTemporalWorker } = await import("../../src/services/funnel/temporal/worker");
  const { startFunnelDispatcher } = await import("../../src/services/funnel/funnelDispatcher");
  const { getEnvironmentIdentity, identityLogFields } = await import("../../src/config/environmentIdentity");

  const started = await startTemporalWorker();
  if (!started) {
    console.error(JSON.stringify({ type: "replica_tmporal_unreachable", label }));
    process.exit(2);
  }
  startFunnelDispatcher({
    intervalMs: interval,
    ...(objectTypes.length > 0 ? { objectTypes } : {}),
  });

  const id = getEnvironmentIdentity();
  console.log(JSON.stringify({
    type: "replica_ready",
    label,
    pid: process.pid,
    namespace: id.temporalNamespace,
    queue: id.temporalTaskQueue,
    workerIdentity: id.workerIdentity,
    objectTypes: objectTypes.length ? objectTypes : null,
    ...identityLogFields(id),
  }));

  // Stay alive indefinitely; the PARENT kills us (that's the experiment).
  await new Promise(() => {});
}

void main().catch((err) => {
  console.error(JSON.stringify({ type: "replica_boot_failed", error: (err as Error).message }));
  process.exit(1);
});
