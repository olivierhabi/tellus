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
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { TRANSFORMS_API_PY, DRIVER_PY } from "./runtime/pythonRuntime.js";
import type { DiscoveredTransform } from "./discovery.js";
import {
  resolveTransformPython,
  resolveJavaHome,
  preflightTransformRuntime,
  resolveRepoDeps,
} from "./runtimeConfig.js";

// Re-export so buildService can preflight without a second import site.
export { preflightTransformRuntime } from "./runtimeConfig.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.TELLUS_TRANSFORM_TIMEOUT_MS ?? 300_000);

// Gap 3 (sandboxed execution): when TELLUS_TRANSFORM_EXECUTION_MODE=container,
// the driver runs inside a Docker container with --network=none --read-only +
// resource caps (--memory/--cpus) + a non-root uid, so arbitrary user-supplied
// transform code CANNOT reach the host filesystem, the network, or unbounded
// resources. The host merely reads the output CSV from the mounted outdir.
const CONTAINER_IMAGE = process.env.TELLUS_TRANSFORM_CONTAINER_IMAGE ?? "tellus/transform-runtime:py38";
const CONTAINER_MEMORY = process.env.TELLUS_TRANSFORM_CONTAINER_MEMORY ?? "1g";
const CONTAINER_CPUS = process.env.TELLUS_TRANSFORM_CONTAINER_CPUS ?? "1";

/** "container" if the operator opted into sandboxed execution AND the image is
 * present; "local" otherwise. Container mode WITHOUT the image is a loud
 * failure (preflight), never a silent local fallback — an operator who set
 * TELLUS_TRANSFORM_EXECUTION_MODE=container expects isolation, not a quiet
 * downgrade to host execution. */
export function executionMode(): "local" | "container" {
  if (process.env.TELLUS_TRANSFORM_EXECUTION_MODE !== "container") return "local";
  return "container";
}

/** Is the container image present locally? (Preflight for container mode.) */
export function containerImageAvailable(): { ok: boolean; image: string; error?: string } {
  const r = spawnSync("docker", ["image", "inspect", CONTAINER_IMAGE], { timeout: 10_000, encoding: "utf8" });
  if (r.status === 0) return { ok: true, image: CONTAINER_IMAGE };
  return {
    ok: false,
    image: CONTAINER_IMAGE,
    error: r.error ? String(r.error) : `docker image inspect exit ${r.status}: ${(r.stderr || "").trim().slice(0, 200)}`,
  };
}

// Minimal, non-secret env passed to the child. JAVA_HOME / SPARK_HOME /
// PYSPARCH_* are required so the PySpark runtime can find the JVM and spawn
// python workers using the same interpreter as the driver.
const ENV_WHITELIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "JAVA_HOME", "SPARK_HOME", "PYSPARK_PYTHON", "PYSPARK_DRIVER_PYTHON",
];

export interface ExecutorInputBinding {
  readonly param: string;
  readonly rid: string;
  readonly path: string;
  readonly format?: string;
  /** Previous committed transaction file (for Input.dataframe(mode='previous')). */
  readonly previousPath?: string | null;
}

export interface ExecuteArgs {
  readonly transform: DiscoveredTransform;
  /** All repo python files (path + content), so intra-repo imports resolve. */
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly inputs: ReadonlyArray<ExecutorInputBinding>;
  /** True when a prior committed transaction exists for the output (ctx.is_incremental). */
  readonly isIncremental?: boolean;
  /** Gap 6: the repo's requirements.txt content (null if none). Resolved into a
   * content-hash-cached deps dir on PYTHONPATH for the driver. */
  readonly requirementsContent?: string | null;
  /** Gap 7: resolved library deps (publisher modules). Written to
   * <workdir>/libs/<name>/ + put on PYTHONPATH for the driver. */
  readonly libs?: ReadonlyArray<{ name: string; files: ReadonlyArray<{ path: string; content: string }> }>;
  readonly timeoutMs?: number;
  /** AbortSignal — on abort (FE Stop / connection close), the spawned child is
   * killed (the process group for local mode incl. the Spark JVM; `docker kill`
   * for container mode) so a cancelled preview doesn't run to the 100s exec
   * timeout after the FE already gave up. Null/undefined = no cancel wiring
   * (builds/tests). */
  readonly signal?: AbortSignal;
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

/** Preflight: is a usable python3 on PATH? (Shim; buildService uses
 * preflightTransformRuntime for the full pyspark+Java check.) */
export function pythonAvailable(): { ok: boolean; version?: string; error?: string } {
  const py = resolveTransformPython();
  try {
    const r = spawnSync(py, ["--version"], { timeout: 5_000, encoding: "utf8" });
    if (r.status === 0) {
      return { ok: true, version: (r.stdout || r.stderr || "").trim() };
    }
    return { ok: false, error: r.error ? String(r.error) : `exit ${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function filterEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  out.PYTHONUNBUFFERED = "1";
  out.PYTHONDONTWRITEBYTECODE = "1";
  // Self-configure: resolve the venv python + Java at call time so a plain
  // restart (no env vars) still finds the runtime.
  const py = resolveTransformPython();
  const jh = resolveJavaHome();
  if (jh && !out.JAVA_HOME) out.JAVA_HOME = jh;
  if (!out.PYSPARK_PYTHON) out.PYSPARK_PYTHON = py;
  if (!out.PYSPARK_DRIVER_PYTHON) out.PYSPARK_DRIVER_PYTHON = py;
  return out;
}

/**
 * Build the TELLUS_TRANSFORM_JOB spec passed to driver.py. Extracted from
 * executeTransform so the isIncremental / previousPath threading has a unit
 * test (these are the fields that carry incremental state to the Python
 * runtime; a regression here would silently break ctx.is_incremental and
 * mode='previous').
 */
export function buildJobSpec(
  args: ExecuteArgs,
  paths: { sdkRoot: string; repoRoot: string; modulePath: string; outputPath: string },
) {
  return {
    sdkRoot: paths.sdkRoot,
    repoRoot: paths.repoRoot,
    modulePath: paths.modulePath,
    entryPoint: args.transform.name,
    outputPath: paths.outputPath,
    isIncremental: args.isIncremental ?? false,
    inputs: args.inputs.map((i) => ({
      param: i.param,
      rid: i.rid,
      path: i.path,
      format: i.format ?? "csv",
      previousPath: i.previousPath ?? null,
    })),
  };
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
  // The output dir (tellus-transform-out-*) is removed by the caller on SUCCESS
  // (it reads exec.outputPath). The inline failure returns below leave it
  // orphaned, so the finally cleans it when !succeeded (was a leak on every
  // timeout / unparseable-stdout / transform-failure preview + dry-run).
  let succeeded = false;

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
      // Containment: resolve + assert dest stays strictly under repoRoot.
      // path.join collapses "..", so without this a path like "../driver.py"
      // would escape the workdir (the /preview route also rejects ".." keys,
      // but the executor is shared with builds/test — guard at the write site).
      const dest = path.resolve(repoRoot, f.path);
      if (dest === repoRoot || !dest.startsWith(repoRoot + path.sep)) continue;
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

    // Gap 6: write the repo's requirements.txt into the workdir root (so the
    // container can pip-install it at /work/requirements.txt). For LOCAL mode,
    // resolve the content-hash-cached deps dir (pip install --target) + put it
    // on PYTHONPATH for the driver.
    const isContainer = executionMode() === "container";
    const hasReqs = typeof args.requirementsContent === "string" && args.requirementsContent.trim().length > 0;
    if (hasReqs) {
      fs.writeFileSync(path.join(workdir, "requirements.txt"), args.requirementsContent as string);
    }
    const repoDeps = !isContainer && hasReqs ? resolveRepoDeps(args.requirementsContent) : null;
    const depsDir = repoDeps?.depsDir ?? null;

    // Gap 7: write each resolved lib module to <workdir>/libs/<name>/<path>.
    // The libs dir is put on PYTHONPATH for the driver (local: <workdir>/libs;
    // container: /work/libs — the workdir is mounted at /work, pure-Python .py
    // files work in the container). `from <name> import ...` then resolves.
    const libsDir = path.join(workdir, "libs");
    let hasLibs = false;
    if (args.libs && args.libs.length > 0) {
      hasLibs = true;
      for (const lib of args.libs) {
        const libRoot = path.join(libsDir, lib.name);
        for (const f of lib.files) {
          const dest = path.join(libRoot, f.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, f.content);
        }
      }
    }
    // The PYTHONPATH parts for the LOCAL driver: per-repo deps dir + the libs dir.
    const localPythonPath = [depsDir, hasLibs ? libsDir : null].filter((p): p is string => typeof p === "string" && p.length > 0);

    // 4. Job spec for the driver. In container mode the paths are CONTAINER
    // paths (the workdir is mounted at /work:ro, the outdir at /out:rw); in
    // local mode they are host paths. The driver resolves 'from transforms.api
    // import ...' to sdkRoot, loads modulePath, and writes outputPath.
    const outDir = path.dirname(outputPath);
    const job = buildJobSpec(args, isContainer
      ? { sdkRoot: "/work/sdk", repoRoot: "/work/repo", modulePath: `/work/repo/${args.transform.sourcePath}`, outputPath: "/out/output.csv" }
      : { sdkRoot: path.join(workdir, "sdk"), repoRoot, modulePath, outputPath });

    const result = isContainer
      ? await runChildContainer(workdir, outDir, JSON.stringify(job), args.timeoutMs ?? DEFAULT_TIMEOUT_MS, hasReqs, hasLibs, args.signal)
      : await runChild(driverPath, workdir, JSON.stringify(job), args.timeoutMs ?? DEFAULT_TIMEOUT_MS, localPythonPath, args.signal);

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

    succeeded = true;
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
    // Always remove the workdir. The output dir (tellus-transform-out-*) is
    // removed by the caller on success (it reads exec.outputPath); on failure
    // the inline returns orphan it, so clean it here when !succeeded.
    if (!succeeded) {
      try { fs.rmSync(path.dirname(outputPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
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

export function runChild(
  driverPath: string,
  cwd: string,
  jobJson: string,
  timeoutMs: number,
  pythonPath: string[] = [],
  abortSignal?: AbortSignal,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const baseEnv: NodeJS.ProcessEnv = { ...filterEnv(), TELLUS_TRANSFORM_JOB: jobJson };
    // Gap 6 + Gap 7: put the per-repo deps dir (pip --target) + the libs dir
    // (publisher modules) on PYTHONPATH so `import <per-repo-pkg>` and
    // `from <lib-name> import ...` resolve. The shared venv's
    // pyspark/pandas/pyarrow remain on the driver's default sys.path.
    if (pythonPath.length > 0) {
      const extra = pythonPath.join(":");
      baseEnv.PYTHONPATH = baseEnv.PYTHONPATH ? `${extra}:${baseEnv.PYTHONPATH}` : extra;
    }
    // detached: the child becomes its own process-group leader so
    // process.kill(-child.pid) reaches the Spark JVM (a child of the python
    // driver) too — a plain child.kill() would orphan the JVM on cancel. The
    // 100s exec timeout (Node's `timeout`→SIGKILL on the direct PID) is
    // UNCHANGED; only the cancel path below uses the group kill.
    const child = spawn(resolveTransformPython(), [driverPath], {
      cwd,
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
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
    // Cancel-on-abort (FE Stop / connection close): SIGTERM the whole process
    // group so the driver can flush, then SIGKILL after a 5s grace if still
    // alive. detached makes -child.pid target only this child's group, NOT the
    // parent Node process. Idempotent + best-effort (kill on a dead PID throws
    // ESRCH -> swallowed).
    let cancelTimer: NodeJS.Timeout | null = null;
    const onCancel = () => {
      const pid = child.pid;
      if (pid === undefined) return; // spawn failed or not yet spawned
      try { process.kill(-pid, "SIGTERM"); } catch { /* already dead */ }
      cancelTimer = setTimeout(() => {
        try { process.kill(-pid, "SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
      if (cancelTimer && typeof cancelTimer.unref === "function") cancelTimer.unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onCancel();
      else abortSignal.addEventListener("abort", onCancel, { once: true });
    }
    const cleanup = () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onCancel);
    };
    child.on("error", (e) => {
      cleanup();
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: (Buffer.concat(err).toString("utf8") + `\nspawn error: ${String(e)}`).trim(),
        exitCode: null,
        timedOut: false,
      });
    });
    child.on("close", (code, signal) => {
      cleanup();
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code,
        timedOut: signal === "SIGKILL",
      });
    });
  });
}

// --------------------------------------------------------------------------
// Gap 3: containerized execution. Runs driver.py inside the transform-runtime
// image with: --network=none (no network egress), --read-only (rootfs frozen),
// --memory/--cpus (resource caps), --user <host-uid> (non-root, can write the
// mounted outdir), --tmpfs /tmp + /home/spark (Spark shuffle + pip cache,
// writable but in-RAM only). The workdir (sdk+driver+repo) is mounted :ro; the
// outdir is mounted :rw so the driver writes /out/output.csv. On timeout, the
// container is `docker kill`ed (a SIGKILL on the docker client would orphan it).
// --------------------------------------------------------------------------
function runChildContainer(
  workdir: string,
  outDir: string,
  jobJson: string,
  timeoutMs: number,
  hasReqs: boolean = false,
  hasLibs: boolean = false,
  abortSignal?: AbortSignal,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const containerName = `tellus-transform-${crypto.randomUUID()}`;
    // Run as the image's `spark` user (uid 185), NOT a numeric host uid — a
    // numeric uid with no /etc/passwd entry leaves Java's user.home unresolved
    // ('?'), crashing Spark's Ivy at startup ("basedir must be absolute:
    // ?/.ivy2/local"). The spark user has a passwd entry -> user.home=/home/spark.
    // The outdir (host-owned, 0700) is chmod'd 0777 below so uid 185 can write
    // the output CSV. Still non-root + read-only + resource-capped + (sandbox)
    // network=none.
    try { fs.chmodSync(outDir, 0o777); } catch { /* best-effort */ }
    // Gap 1 (distributed execution): when TELLUS_SPARK_MASTER is set, the
    // driver joins that standalone cluster. It needs network reachability to
    // the master, so --network=none (sandbox) is replaced with the spark
    // bridge network (default spark-net). Honest trade-off: the cluster path
    // is still containerized (read-only, resource caps, non-root) but is NOT
    // network-isolated — the driver must reach spark://master:7077.
    // Gap 6 (per-repo deps in container): pip install needs pypi egress, which
    // --network=none forbids. So when the repo has a requirements.txt AND we're
    // in sandbox mode (no cluster), use the default bridge (pypi access). This
    // trades network isolation for per-repo deps — an operator who needs BOTH
    // isolation AND per-repo deps must bake the deps into a derived image.
    // (Cluster + per-repo deps is the one unsupported combo: spark-net has no
    // pypi egress -> pip fails loudly; bake deps into the image for that path.)
    const sparkMaster = process.env.TELLUS_SPARK_MASTER;
    const network = sparkMaster
      ? process.env.TELLUS_SPARK_NETWORK ?? "spark-net"
      : (hasReqs ? "bridge" : "none");
    const dockerArgs = [
      "run", "--rm", "--name", containerName,
      `--network=${network}`,
      // Gap 1: the container's --hostname (== its --name) is resolvable on the
      // spark-net bridge; advertise it as spark.driver.host so executors on
      // workers can call back to the driver (else a distributed task hangs).
      ...(sparkMaster ? ["--hostname", containerName] : []),
      "--read-only",
      `--memory=${CONTAINER_MEMORY}`,
      `--cpus=${CONTAINER_CPUS}`,
      "--user", "spark",
      // /tmp must be exec — Spark extracts the zstd-jni native lib
      // (libzstd-jni-*.so) to java.io.tmpdir + mmaps it executable; a noexec
      // tmpfs makes shuffle/map-status compression fail ("failed to map
      // segment from shared object"). 1777 so the non-root spark uid can write.
      "--tmpfs", "/tmp:size=128m,mode=1777,exec",
      "--tmpfs", "/home/spark:size=64m,mode=1777",
      "-v", `${workdir}:/work:ro`,
      "-v", `${outDir}:/out`,
      "-e", `TELLUS_TRANSFORM_JOB=${jobJson}`,
      "-e", "HOME=/home/spark",
    ];
    if (sparkMaster) dockerArgs.push("-e", `TELLUS_SPARK_MASTER=${sparkMaster}`, "-e", `TELLUS_SPARK_DRIVER_HOST=${containerName}`);
    // Gap 6 + Gap 7: in container mode, per-repo deps are pip-installed at
    // /tmp/deps (in-container, Linux wheels) + the libs dir (/work/libs, pure
    // Python) are put on PYTHONPATH, then the driver runs. Four combos:
    const ppParts: string[] = [];
    if (hasReqs) ppParts.push("/tmp/deps");
    if (hasLibs) ppParts.push("/work/libs");
    const pp = ppParts.length > 0 ? `PYTHONPATH=${ppParts.join(":")} ` : "";
    const cmd = hasReqs
      ? `pip install --quiet --target /tmp/deps -r /work/requirements.txt && ${pp}python3 /work/driver.py`
      : `${pp}python3 /work/driver.py`;
    dockerArgs.push(CONTAINER_IMAGE, "bash", "-c", cmd);
    const child = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    const CAP = 8 * 1024 * 1024;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      // Kill the container by name (the docker client will then exit; --rm
      // removes the container). Best-effort — if it fails, the client still
      // gets SIGKILL below.
      try { spawnSync("docker", ["kill", containerName], { timeout: 5_000 }); } catch { /* best-effort */ }
      try { child.kill("SIGKILL"); } catch { /* best-effort */ }
    }, timeoutMs);
    // Cancel-on-abort (FE Stop / connection close): SIGTERM the container (lets
    // the driver flush), then SIGKILL after a 5s grace (docker kill default =
    // SIGKILL, kills the whole cgroup — no JVM orphan). Shares the `killed` flag
    // with the timeout so they don't double-kill; the timeout (100s) only fires
    // if no cancel arrived, so they don't race in practice.
    let cancelTimer: NodeJS.Timeout | null = null;
    const onCancel = () => {
      if (killed) return;
      killed = true;
      try { spawnSync("docker", ["kill", "--signal=SIGTERM", containerName], { timeout: 5_000 }); } catch { /* best-effort */ }
      cancelTimer = setTimeout(() => {
        try { spawnSync("docker", ["kill", containerName], { timeout: 5_000 }); } catch { /* best-effort */ }
      }, 5_000);
      if (cancelTimer && typeof cancelTimer.unref === "function") cancelTimer.unref();
    };
    if (abortSignal) {
      if (abortSignal.aborted) onCancel();
      else abortSignal.addEventListener("abort", onCancel, { once: true });
    }
    const cleanup = () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onCancel);
    };
    child.stdout.on("data", (b: Buffer) => { if (outLen < CAP) { out.push(b); outLen += b.length; } });
    child.stderr.on("data", (b: Buffer) => { if (errLen < CAP) { err.push(b); errLen += b.length; } });
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: (Buffer.concat(err).toString("utf8") + `\nspawn error: ${String(e)}`).trim(),
        exitCode: null,
        timedOut: killed,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      cleanup();
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: code,
        timedOut: killed,
      });
    });
  });
}
