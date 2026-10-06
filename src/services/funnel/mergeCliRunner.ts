// ---------------------------------------------------------------------------
// mergeCliRunner — run merge SQL in a SEPARATE DuckDB CLI process.
//
// WHY THIS EXISTS — Phase 0/1 incident (PaySIM Transaction, 6,362,620 rows).
// The identical merge SQL completed in 61.1 s in a standalone DuckDB CLI
// v1.4.4 process (measured: standalone path) while the in-process
// `duckdb` node binding deadlocked for 90+ minutes (measured: in-process
// path): all 7 TaskScheduler workers parked in `semaphore_wait_trap` with the
// executor waiting on a condvar in `Executor::WaitForTask`. The engine is not
// the defect; the Node binding/integration layer is. Evidence from one code
// path does not transfer to another, so this module is deliberately a
// different process, not a different query.
//
// What this module does:
//   * spawns a DuckDB CLI (`DUCKDB_CLI_PATH`, default `duckdb`) with the
//     merge script on stdin and stdout/stderr captured to files in workDir;
//   * applies the SAME DuckDB settings the in-process pool applies
//     (memory_limit, temp_directory, threads-only-if-positive,
//     preserve_insertion_order=false, home_directory) — see
//     {@link cliSettingsPreamble}. The one deliberate deviation is the spill
//     directory: a per-run dir under workDir instead of the shared
//     `/tmp/duckdb_spill`, so the watchdog attributes spill growth to THIS
//     run and concurrent in-process DuckDB work cannot confuse it;
//   * enforces a HARD timeout (default 30 min, `FUNNEL_MERGE_CLI_TIMEOUT_MS`)
//     with SIGTERM-then-SIGKILL escalation — SIGTERM alone cannot interrupt a
//     thread blocked in native code (measured: Phase 0 needed SIGKILL);
//   * enforces a PROGRESS watchdog: spill + watched-output bytes must grow
//     within `FUNNEL_STAGE_STALL_AFTER_MS` (default 60 s, shared with
//     stageProgress.ts), otherwise the child is killed and a CliStallError
//     is thrown. A lease heartbeat on the JS thread would have stayed fresh
//     through the Phase 0 deadlock, so liveness here is bytes-on-disk, not
//     process-alive.
//
// Killing a wedged CLI child never touches the API process — that is the
// isolation boundary this module exists to provide.
// ---------------------------------------------------------------------------

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MERGE_CLI_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;
export const MERGE_CLI_KILL_GRACE_MS_DEFAULT = 5_000;
export const MERGE_CLI_WATCHDOG_POLL_MS_DEFAULT = 2_000;
export const MERGE_CLI_VERSION_CHECK_TIMEOUT_MS = 10_000;

/** Distinct failure modes so callers (and the STALLED watchdog) can tell a
 *  wedged child from a merely-slow one and from a SQL error. */
export class CliTimeoutError extends Error {
  readonly workDir: string;
  readonly wallMs: number;
  readonly peakSpillBytes: number;
  constructor(workDir: string, wallMs: number, peakSpillBytes: number) {
    super(
      `DuckDB CLI merge exceeded hard timeout after ${wallMs}ms ` +
        `(workDir=${workDir} peakSpillBytes=${peakSpillBytes})`,
    );
    this.name = "CliTimeoutError";
    this.workDir = workDir;
    this.wallMs = wallMs;
    this.peakSpillBytes = peakSpillBytes;
  }
}

export class CliStallError extends Error {
  readonly workDir: string;
  readonly wallMs: number;
  readonly lastProgressAt: number;
  constructor(workDir: string, wallMs: number, lastProgressAt: number) {
    super(
      `DuckDB CLI merge stalled: no spill/output growth for ` +
        `${wallMs - lastProgressAt}ms (workDir=${workDir})`,
    );
    this.name = "CliStallError";
    this.workDir = workDir;
    this.wallMs = wallMs;
    this.lastProgressAt = lastProgressAt;
  }
}

export class CliExitError extends Error {
  readonly workDir: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;
  constructor(workDir: string, exitCode: number | null, stderrTail: string) {
    super(
      `DuckDB CLI merge exited with code ${exitCode} ` +
        `(workDir=${workDir}): ${stderrTail.slice(0, 500)}`,
    );
    this.name = "CliExitError";
    this.workDir = workDir;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

export interface CliRunResult {
  wallMs: number;
  peakSpillBytes: number;
  stdoutPath: string;
  stderrPath: string;
  scriptPath: string;
}

export interface CliProgress {
  wallMs: number;
  spillBytes: number;
  watchedBytes: number;
}

export interface RunCliScriptOptions {
  /** Full SQL script text (settings preamble included by the caller via
   *  {@link cliSettingsPreamble}, or raw for tests). */
  scriptText: string;
  /** Caller-owned dir: receives script.sql, stdout.log, stderr.log and —
   *  by convention — the spill/ subdir and any COPY outputs. Kept on
   *  failure for forensics; the caller owns lifecycle on success. */
  workDir: string;
  /** Spill dir the script's `PRAGMA temp_directory` points at. */
  spillDir: string;
  /** Extra output paths whose byte growth counts as progress (e.g. the
   *  prefix parquet files). */
  watchPaths?: string[];
  timeoutMs?: number;
  stallAfterMs?: number;
  pollMs?: number;
  killGraceMs?: number;
  /** Test hook: replaces [cliPath] as the spawned command. */
  command?: string[];
  onProgress?: (p: CliProgress) => void;
}

function positiveIntEnv(
  value: string | undefined,
  def: number,
): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function mergeCliTimeoutMs(): number {
  return positiveIntEnv(
    process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS,
    MERGE_CLI_TIMEOUT_MS_DEFAULT,
  );
}

/** `DUCKDB_CLI_PATH`, default `duckdb` on PATH. The production image must
 *  ship a DuckDB CLI binary for the out-of-process merge path. */
export function duckDbCliPath(): string {
  return process.env.DUCKDB_CLI_PATH ?? "duckdb";
}

let cachedAvailability: boolean | null = null;

/** Is a DuckDB CLI runnable here? Cached per process. Never throws. */
export async function isDuckDbCliAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability;
  try {
    const child = spawn(duckDbCliPath(), ["--version"], {
      stdio: "ignore",
    });
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve(false);
      }, MERGE_CLI_VERSION_CHECK_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(t);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
    });
    cachedAvailability = ok;
    return ok;
  } catch {
    cachedAvailability = false;
    return false;
  }
}

/** Test hook: reset the cached availability probe. */
export function resetCliAvailabilityCache(): void {
  cachedAvailability = null;
}

export interface CliSettings {
  memoryLimit: string;
  /** Spill dir for `PRAGMA temp_directory`. Per-run under workDir. */
  tempDirectory: string;
  /** Omitted from the preamble when <= 0 (DuckDB auto) — mirrors the pool. */
  threads: number;
  homeDirectory: string;
}

/** Read DuckDB settings with the pool's exact defaults (pool.ts
 *  applyInstanceSettings): memory_limit 1GB, threads unset (= auto), and the
 *  same env names. tempDirectory/homeDirectory take explicit per-run values
 *  from the caller instead of the shared pool defaults. */
export function resolveCliSettings(
  tempDirectory: string,
  homeDirectory: string,
): CliSettings {
  const threads = Number(process.env.DUCKDB_THREADS ?? "0");
  return {
    memoryLimit: process.env.DUCKDB_MEMORY_LIMIT ?? "1GB",
    tempDirectory,
    threads: Number.isFinite(threads) ? threads : 0,
    homeDirectory,
  };
}

/** Render the settings preamble. Statement order mirrors pool.ts
 *  (home_directory before anything that could INSTALL/LOAD; temp_directory
 *  set-once-before-spill). `threads` is emitted ONLY when > 0 — the pool
 *  never issues `SET threads` for the default, and DuckDB's auto must not
 *  be overridden with 0. */
export function cliSettingsPreamble(s: CliSettings): string {
  const lines = [
    `SET home_directory='${s.homeDirectory.replace(/'/g, "''")}';`,
    `SET memory_limit='${s.memoryLimit.replace(/'/g, "''")}';`,
    `PRAGMA temp_directory='${s.tempDirectory.replace(/'/g, "''")}';`,
  ];
  if (s.threads > 0) {
    lines.push(`SET threads=${Math.floor(s.threads)};`);
  }
  lines.push(`SET preserve_insertion_order=false;`);
  return lines.join("\n") + "\n";
}

function dirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    try {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.statSync(p).size;
    } catch {
      /* racing with the child — ignore */
    }
  }
  return total;
}

function fileBytes(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

async function killChild(
  child: ChildProcess,
  killGraceMs: number,
): Promise<void> {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), killGraceMs);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a SQL script in a separate DuckDB CLI process with a hard timeout and
 * a bytes-on-disk progress watchdog. The script is fed on stdin; nothing is
 * parsed from stdout (callers read their COPY outputs from workDir).
 */
export async function runDuckDbCliScript(
  opts: RunCliScriptOptions,
): Promise<CliRunResult> {
  const {
    scriptText,
    workDir,
    spillDir,
    watchPaths = [],
    pollMs = MERGE_CLI_WATCHDOG_POLL_MS_DEFAULT,
    killGraceMs = MERGE_CLI_KILL_GRACE_MS_DEFAULT,
    onProgress,
  } = opts;
  const timeoutMs = opts.timeoutMs ?? mergeCliTimeoutMs();
  const stallAfterMs =
    opts.stallAfterMs ??
    (() => {
      const raw = Number(process.env.FUNNEL_STAGE_STALL_AFTER_MS ?? 60_000);
      return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
    })();

  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(spillDir, { recursive: true });
  const scriptPath = path.join(workDir, "script.sql");
  const stdoutPath = path.join(workDir, "stdout.log");
  const stderrPath = path.join(workDir, "stderr.log");
  fs.writeFileSync(scriptPath, scriptText);

  const outFd = fs.openSync(stdoutPath, "w");
  const errFd = fs.openSync(stderrPath, "w");
  const command = opts.command ?? [duckDbCliPath()];
  const child = spawn(command[0], command.slice(1), {
    stdio: ["pipe", outFd, errFd],
  });

  const startedAt = Date.now();
  let peakSpillBytes = 0;
  let lastProgressAt = startedAt;
  let lastObserved = -1;
  let settled = false;

  const observe = (): { spillBytes: number; watchedBytes: number } => {
    const spillBytes = dirBytes(spillDir);
    let watchedBytes = 0;
    for (const p of watchPaths) watchedBytes += fileBytes(p);
    return { spillBytes, watchedBytes };
  };

  // Seed: an empty spill dir reads as 0 bytes, which must not count as
  // "no progress" before the child has had a chance to write.
  const report = () => {
    const { spillBytes, watchedBytes } = observe();
    if (spillBytes > peakSpillBytes) peakSpillBytes = spillBytes;
    const total = spillBytes + watchedBytes;
    if (total > lastObserved) {
      lastObserved = total;
      lastProgressAt = Date.now();
    }
    // A throwing progress callback must never kill the watchdog interval —
    // liveness reporting is best-effort by construction. Log and continue.
    try {
      onProgress?.({
        wallMs: Date.now() - startedAt,
        spillBytes,
        watchedBytes,
      });
    } catch (e) {
      console.warn(
        "[merge-cli] onProgress threw; watchdog continues —",
        e instanceof Error ? e.message : String(e),
      );
    }
    return { spillBytes, watchedBytes };
  };

  if (!child.stdin) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw new CliExitError(workDir, null, "spawn failed: no stdin pipe");
  }
  child.stdin.write(scriptText);
  child.stdin.end();

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (settled) return;
        const now = Date.now();
        const { spillBytes } = report();
        if (spillBytes > peakSpillBytes) peakSpillBytes = spillBytes;
        if (now - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(
            new CliTimeoutError(workDir, now - startedAt, peakSpillBytes),
          );
          return;
        }
        if (now - lastProgressAt > stallAfterMs) {
          clearInterval(timer);
          reject(new CliStallError(workDir, now - startedAt, lastProgressAt));
        }
      }, pollMs);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        reject(
          new CliExitError(
            workDir,
            null,
            `spawn failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
      });
      child.on("exit", (code) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (code === 0) {
          report();
          resolve();
        } else {
          let tail = "";
          try {
            const buf = fs.readFileSync(stderrPath);
            tail = buf.slice(Math.max(0, buf.length - 4000)).toString();
          } catch {
            /* ignore */
          }
          reject(new CliExitError(workDir, code, tail));
        }
      });
    });
  } catch (err) {
    await killChild(child, killGraceMs);
    // Reap: the exit handler already ran or will run; make sure the child
    // is gone before returning so no zombie outlives the watchdog.
    throw err;
  } finally {
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(errFd);
    } catch {
      /* ignore */
    }
  }

  return {
    wallMs: Date.now() - startedAt,
    peakSpillBytes,
    stdoutPath,
    stderrPath,
    scriptPath,
  };
}

/**
 * Should the merge run out of process? Strict opt-in
 * (`FUNNEL_MERGE_OUT_OF_PROCESS=1`, same convention as
 * FUNNEL_OPENSEARCH_PIPELINE) AND a runnable CLI. Flag on but no CLI falls
 * back to the in-process path with a loud warning — availability over
 * isolation, never silent.
 */
export async function shouldUseOutOfProcessMerge(): Promise<{
  outOfProcess: boolean;
  reason: string;
}> {
  if (process.env.FUNNEL_MERGE_OUT_OF_PROCESS !== "1") {
    return { outOfProcess: false, reason: "flag-off" };
  }
  if (!(await isDuckDbCliAvailable())) {
    console.warn(
      "[merge-cli] FUNNEL_MERGE_OUT_OF_PROCESS=1 but no DuckDB CLI found " +
        `(DUCKDB_CLI_PATH=${duckDbCliPath()}) — falling back to in-process merge`,
    );
    return { outOfProcess: false, reason: "cli-missing" };
  }
  return { outOfProcess: true, reason: "flag-on-cli-available" };
}
