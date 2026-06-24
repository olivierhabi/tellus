// ---------------------------------------------------------------------------
// B4 — Foundry worker entrypoint (spec §B4 line 200).
//
// Runs INSIDE the child_process sandbox. Order is critical:
//   1. Parse JobSpec from env.
//   2. Install egress allowlist BEFORE importing pg or any net-using module.
//   3. Drop privileges on Linux if root.
//   4. Fetch credentials (B2 internal unwrap).
//   5. Dispatch to strategy (B5 snapshot/append, B7 CDC).
//   6. Emit terminal IPC event and exit.
//
// All output to parent goes via process.send() as RuntimeEvent shapes.
// Crashes propagate via non-zero exit; the parent classifies as IMPORT_FAILED.
// ---------------------------------------------------------------------------

import { installEgressAllowlist } from "../../services/orchestration/runners/egress-allowlist";
import type { JobSpec, RuntimeEvent } from "../../services/orchestration/runners/runtime-adapter";

function emit(e: RuntimeEvent): void {
  if (process.send) process.send(e);
}

async function main(): Promise<number> {
  const raw = process.env.TELLUS_JOB_SPEC;
  if (!raw) {
    emit({
      buildRid: "unknown",
      ts: new Date().toISOString(),
      kind: "failed",
      data: { reason: "TELLUS_JOB_SPEC missing from env" },
    });
    return 2;
  }
  const spec = JSON.parse(raw) as JobSpec;

  // 1) install egress allowlist FIRST
  installEgressAllowlist(spec.egress);

  // 2) optional unprivileged-user transition on Linux
  if (process.platform === "linux" && process.getuid && process.getuid() === 0) {
    const uid = Number(process.env.TELLUS_WORKER_UID ?? "65534");
    const gid = Number(process.env.TELLUS_WORKER_GID ?? "65534");
    try {
      if (process.setgid) process.setgid(gid);
      if (process.setuid) process.setuid(uid);
    } catch (err) {
      emit({
        buildRid: spec.buildRid,
        ts: new Date().toISOString(),
        kind: "failed",
        data: { reason: `privilege drop failed: ${(err as Error).message}` },
      });
      return 3;
    }
  }

  emit({
    buildRid: spec.buildRid,
    ts: new Date().toISOString(),
    kind: "started",
    data: { tenant: spec.tenant, importRid: spec.importRid },
  });

  // 3) lazy-import network modules AFTER egress patch is active
  const { fetchCredential } = await import("./credential-fetch");
  const creds = await fetchCredential(spec.connectionRid, "default").catch((err) => {
    emit({
      buildRid: spec.buildRid,
      ts: new Date().toISOString(),
      kind: "failed",
      data: { reason: `credential fetch failed: ${(err as Error).message}` },
    });
    return null;
  });
  if (!creds) return 4;

  // 4) dispatch to strategy
  const strategy = (spec.payload?.strategy as string) ?? "snapshot";
  try {
    if (strategy === "snapshot") {
      const mod = await import("./strategies/snapshot");
      await mod.runSnapshot(spec, creds);
    } else if (strategy === "append") {
      const mod = await import("./strategies/append");
      await mod.runAppend(spec, creds);
    } else if (strategy === "cdc") {
      const mod = await import("./strategies/cdc");
      await mod.runCdc(spec, creds);
    } else {
      throw new Error(`unknown strategy: ${strategy}`);
    }
  } catch (err) {
    emit({
      buildRid: spec.buildRid,
      ts: new Date().toISOString(),
      kind: "failed",
      data: { reason: (err as Error).message ?? String(err) },
    });
    return 5;
  }

  emit({
    buildRid: spec.buildRid,
    ts: new Date().toISOString(),
    kind: "succeeded",
  });
  return 0;
}

// Entrypoint guard so this module is importable for tests.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      emit({
        buildRid: "unknown",
        ts: new Date().toISOString(),
        kind: "failed",
        data: { reason: `top-level rejection: ${(err as Error).message}` },
      });
      process.exit(99);
    });
}

export { main };
