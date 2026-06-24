// ===========================================================================
// Transform executor — runs one discovered @transform in a sandboxed python3
// child process against real dataset files.
//
// Mirrors the spawn/lifecycle pattern of services/pipelines/icebergSidecar.ts
// (already spawns python3) and the env-scrub discipline of the orchestration
// child-process-sandbox: a per-build temp workdir as cwd, a scrubbed env, a
// hard deadline with SIGKILL, and a JSON-over-stdout result protocol.
// ===========================================================================
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { TRANSFORMS_API_PY, DRIVER_PY } from "./runtime/pythonRuntime.js";
import type { DiscoveredTransform } from "./discovery.js";

const PYTHON_BIN =
  process.env.TELLUS_PYTHON_BIN || process.env.PB_B4_PYTHON || "python3";

const DEFAULT_TIMEOUT_MS = Number(process.env.TELLUS_TRANSFORM_TIMEOUT_MS ?? 60_000);

// Only a minimal, non-secret env is passed to the child.
const ENV_WHITELIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export interface ExecutorInputBinding {
  readonly param: string;
  readonly rid: string;
  readonly path: string;
  readonly format?: string;
}

export interface ExecuteArgs {
  readonly transform: DiscoveredTransform;
  /** All repo python files (path + content), so intra-repo imports resolve. */
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly inputs: ReadonlyArray<ExecutorInputBinding>;
  readonly timeoutMs?: number;
}

export interface ExecuteResult {
  readonly ok: boolean;
  /** Absolute path of the written output CSV (caller materializes + removes). */
  readonly outputPath: string | null;
  readonly rowCount: number;
  readonly columns: string[];
  readonly writeMode: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  readonly traceback: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Preflight: is a usable python3 on PATH? */
export function pythonAvailable(): { ok: boolean; version?: string; error?: string } {
  try {
    const r = spawnSync(PYTHON_BIN, ["--version"], { timeout: 5_000, encoding: "utf8" });
    if (r.status === 0) {
      return { ok: true, version: (r.stdout || r.stderr || "").trim() };
    }
    return { ok: false, error: r.error ? String(r.error) : `exit ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function filterEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  out.PYTHONUNBUFFERED = "1";
  out.PYTHONDONTWRITEBYTECODE = "1";
  return out;
}

/**
 * Execute the transform. The output CSV is written outside the (deleted)
 * workdir so the caller can move it into the dataset store.
 */
export async function executeTransform(args: ExecuteArgs): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "tellus-transform-"));
  const outputPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "tellus-transform-out-")),
    "output.csv",
  );

  try {
    // 1. SDK package (the transforms.api the user code imports).
    const sdkPkg = path.join(workdir, "sdk", "transforms");
    fs.mkdirSync(sdkPkg, { recursive: true });
    fs.writeFileSync(path.join(sdkPkg, "__init__.py"), "");
    fs.writeFileSync(path.join(sdkPkg, "api.py"), TRANSFORMS_API_PY);

    // 2. Driver.
    const driverPath = path.join(workdir, "driver.py");
    fs.writeFileSync(driverPath, DRIVER_PY);

    // 3. User repo files (preserve structure so intra-repo imports resolve).
    const repoRoot = path.join(workdir, "repo");
    for (const f of args.files) {
      if (!f.path.endsWith(".py")) continue;
      const dest = path.join(repoRoot, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.content);
    }
    const modulePath = path.join(repoRoot, args.transform.sourcePath);
    if (!fs.existsSync(modulePath)) {
      return failure(
        outputPath,
        startedAt,
        `transform source ${args.transform.sourcePath} not found in repo files`,
      );
    }

    // 4. Job spec for the driver.
    const job = {
      sdkRoot: path.join(workdir, "sdk"),
      repoRoot,
      modulePath,
      entryPoint: args.transform.name,
      outputPath,
      inputs: args.inputs.map((i) => ({
        param: i.param,
        rid: i.rid,
        path: i.path,
        format: i.format ?? "csv",
      })),
    };

    const result = await runChild(
      driverPath,
      workdir,
      JSON.stringify(job),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    if (result.timedOut) {
      return {
        ok: false,
        outputPath: null,
        rowCount: 0,
        columns: [],
        writeMode: "replace",
        stdout: result.stdout,
        stderr: result.stderr,
        error: `transform timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        traceback: null,
        timedOut: true,
        durationMs: Date.now() - startedAt,
      };
    }

    let parsed: {
      ok: boolean;
      result?: { rowCount: number; columns: string[]; mode: string };
      error?: string;
      traceback?: string;
    } | null = null;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      parsed = null;
    }

    if (!parsed) {
      return {
        ok: false,
        outputPath: null,
        rowCount: 0,
        columns: [],
        writeMode: "replace",
        stdout: result.stdout,
        stderr: result.stderr,
        error:
          result.exitCode === 0
            ? "transform produced no parseable result"
            : `transform exited with code ${result.exitCode}`,
        traceback: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    }

    if (!parsed.ok) {
      return {
        ok: false,
        outputPath: null,
        rowCount: 0,
        columns: [],
        writeMode: "replace",
        stdout: result.stdout,
        stderr: result.stderr,
        error: parsed.error ?? "transform failed",
        traceback: parsed.traceback ?? null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      outputPath,
      rowCount: parsed.result?.rowCount ?? 0,
      columns: parsed.result?.columns ?? [],
      writeMode: parsed.result?.mode ?? "replace",
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
      traceback: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // Always remove the workdir; the output file (if any) lives elsewhere and
    // is removed by the caller after materialization.
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

function failure(outputPath: string, startedAt: number, error: string): ExecuteResult {
  try {
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return {
    ok: false,
    outputPath: null,
    rowCount: 0,
    columns: [],
    writeMode: "replace",
    stdout: "",
    stderr: "",
    error,
    traceback: null,
    timedOut: false,
    durationMs: Date.now() - startedAt,
  };
}

interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runChild(
  driverPath: string,
  cwd: string,
  jobJson: string,
  timeoutMs: number,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [driverPath], {
      cwd,
      env: { ...filterEnv(), TELLUS_TRANSFORM_JOB: jobJson },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const CAP = 8 * 1024 * 1024; // 8 MiB cap per stream
    child.stdout.on("data", (b: Buffer) => {
      if (outLen < CAP) {
        out.push(b);
        outLen += b.length;
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (errLen < CAP) {
        err.push(b);
        errLen += b.length;
      }
    });
    child.on("error", (e) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: (Buffer.concat(err).toString("utf8") + `\nspawn error: ${String(e)}`).trim(),
        exitCode: null,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code,
        timedOut: signal === "SIGKILL",
      });
    });
  });
}
