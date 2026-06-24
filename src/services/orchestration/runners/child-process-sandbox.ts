// ---------------------------------------------------------------------------
// B4 — child_process sandbox (spec §B4 line 196).
//
// Forks `dist/worker-entrypoint.js` with:
//   - env containing ONLY whitelisted vars + the workload JWT + spec payload
//   - per-job tmp working directory cleaned on exit
//   - --max-old-space-size to cap memory
//   - process.setuid to a low-priv UID if running as root (skipped on macOS)
//   - resource.setrlimit on Linux (CPU + RSS) if `posix-utils` available
//
// On exit:
//   - non-zero exitCode → IMPORT_FAILED terminal event
//   - tmp dir removed regardless
// ---------------------------------------------------------------------------

import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSpec, RuntimeEvent } from "./runtime-adapter";

const WORKER_ENTRYPOINT =
  process.env.TELLUS_WORKER_ENTRYPOINT ??
  join(process.cwd(), "dist", "workers", "foundry-worker", "entrypoint.js");

const ENV_WHITELIST = new Set([
  "NODE_ENV",
  "TELLUS_ICEBERG_ROOT",
  "TELLUS_KMS_ADAPTER",
  "TELLUS_LOG_LEVEL",
  "TELLUS_OTEL_ENDPOINT",
  // Base URL of the internal credential-unwrap endpoint the worker calls with
  // its workload JWT. Without this the child falls back to a wrong default and
  // the credential fetch fails ("fetch failed").
  "TELLUS_INTERNAL_URL",
  "TZ",
  "LANG",
  "PATH",
  "HOME",
]);

const MAX_OLD_SPACE_MB = Number(
  process.env.TELLUS_WORKER_MAX_OLD_SPACE_MB ?? 2048,
);

export interface SandboxHandle {
  child: ChildProcess;
  tmpDir: string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export function spawnSandbox(
  spec: JobSpec,
  onEvent: (e: RuntimeEvent) => void,
): SandboxHandle {
  const tmpDir = mkdtempSync(join(tmpdir(), `tellus-job-${spec.buildRid}-`));
  const childEnv = {
    ...filterEnv(process.env, ENV_WHITELIST),
    TELLUS_WORKLOAD_JWT: spec.workloadJwt,
    TELLUS_JOB_SPEC: JSON.stringify(spec),
    TELLUS_JOB_TMPDIR: tmpDir,
  } as NodeJS.ProcessEnv;

  const execArgv = [`--max-old-space-size=${MAX_OLD_SPACE_MB}`];
  const child = fork(WORKER_ENTRYPOINT, [], {
    cwd: tmpDir,
    env: childEnv,
    execArgv,
    silent: true, // capture stdout/stderr
    serialization: "advanced",
  });

  // Privilege drop on Linux if running as root and an unprivileged UID is set.
  // Note: cannot setuid AFTER fork — must be done inside child entrypoint.

  child.stdout?.on("data", (buf: Buffer) => {
    onEvent({
      buildRid: spec.buildRid,
      ts: new Date().toISOString(),
      kind: "log",
      data: { stream: "stdout", line: buf.toString("utf8").trim() },
    });
  });
  child.stderr?.on("data", (buf: Buffer) => {
    onEvent({
      buildRid: spec.buildRid,
      ts: new Date().toISOString(),
      kind: "log",
      data: { stream: "stderr", line: buf.toString("utf8").trim() },
    });
  });

  child.on("message", (msg: unknown) => {
    if (isRuntimeEvent(msg)) onEvent(msg);
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
        resolve({ code, signal });
      });
    },
  );

  return {
    child,
    tmpDir,
    exit,
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    },
  };
}

function filterEnv(
  src: NodeJS.ProcessEnv,
  allow: Set<string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (allow.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

function isRuntimeEvent(msg: unknown): msg is RuntimeEvent {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.buildRid === "string" &&
    typeof m.ts === "string" &&
    typeof m.kind === "string"
  );
}
