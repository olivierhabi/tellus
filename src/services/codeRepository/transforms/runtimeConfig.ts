// ===========================================================================
// runtimeConfig.ts — resolve + preflight the PySpark build runtime.
//
// PROBLEM (P0 env fragility): the executor used to read
// `PYTHON_BIN = process.env.TELLUS_PYTHON_BIN || "python3"` at module load.
// A plain backend restart WITHOUT TELLUS_PYTHON_BIN/JAVA_HOME/PYSPARK_PYTHON
// set fell back to system `python3` (no pyspark), and builds failed with the
// cryptic child error "No module named 'pyspark'" — the service ran silently
// in a broken state.
//
// FIX: self-configure + fail loudly.
//   - resolveTransformPython() / resolveJavaHome() walk a list of candidate
//     paths (env vars first, then the provisioned venv at
//     ~/.tellus/transform-runtime-venv, then /tmp/pyspark-spike-venv, then
//     openjdk@21/@17) so a plain restart finds the runtime without env vars.
//   - preflightTransformRuntime() actually imports pyspark + pandas + pyarrow
//     (with JAVA_HOME set) and runs `java -version`, returning a clear error
//     if any step fails. buildService.startBuild calls this BEFORE enqueuing
//     a build, so a misconfigured backend fails the build with a 503
//     Transform:RuntimeNotConfigured carrying the exact reason + the fix
//     command — not the cryptic child error.
// ===========================================================================
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Candidate PySpark-venv python binaries, in priority order. The env vars
// win; then the canonical provisioned venv (~/.tellus/transform-runtime-venv,
// created by scripts/verify-transforms-parity.sh); then the spike venv; then
// bare `python3` as a last resort (likely broken — preflight will catch it).
function candidatePythons(): string[] {
  const out: string[] = [
    process.env.TELLUS_PYTHON_BIN,
    process.env.PB_B4_PYTHON,
    path.join(os.homedir(), ".tellus", "transform-runtime-venv", "bin", "python"),
    "/tmp/pyspark-spike-venv/bin/python",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  out.push("python3"); // last resort
  return out;
}

// Candidate JAVA_HOMEs (PySpark 4.x needs Java 17+; 11 is too old, 25 hits
// Spark's getSubject error, 21 is the known-good).
function candidateJavaHomes(): string[] {
  const out: string[] = [
    process.env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home",
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  try {
    const jh = spawnSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf8", timeout: 3_000 });
    if (jh.status === 0 && jh.stdout.trim()) out.push(jh.stdout.trim());
  } catch {
    /* not on macOS — skip */
  }
  return out;
}

/** Resolve the python binary to use for transform execution (self-configures
 * from known venv paths; falls back to `python3`). */
export function resolveTransformPython(): string {
  for (const c of candidatePythons()) {
    if (c === "python3") return c; // PATH lookup — accept; preflight catches a broken one.
    if (fs.existsSync(c)) return c;
  }
  return "python3";
}

/** Resolve JAVA_HOME (self-configures from known openjdk paths). */
export function resolveJavaHome(): string | undefined {
  for (const c of candidateJavaHomes()) {
    if (fs.existsSync(path.join(c, "bin", "java"))) return c;
  }
  return undefined;
}

export interface RuntimePreflight {
  readonly ok: boolean;
  readonly python: string;
  readonly javaHome: string | undefined;
  readonly version?: string;
  readonly error?: string;
}

// ===========================================================================
// Gap 6: per-repo reproducible environment management.
//
// A repo can declare a `requirements.txt` at its root. Its content is hashed;
// the deps are `pip install --target`-ed into a content-hashed dir
// (~/.tellus/transform-deps/<hash>/) — CACHED across builds with the same
// requirements (the hash matches → reuse, no re-install). The driver runs with
// the shared venv python (which has pyspark/pandas/pyarrow) + the deps dir on
// PYTHONPATH, so per-repo deps are isolated per repo (repo A's deps are NOT
// visible to repo B unless B declares the same requirement). `--target` is
// used (not a venv) so the shared pyspark/pandas/pyarrow remain available
// without --system-site-packages inheritance issues.
// ===========================================================================
const DEPS_ROOT = path.join(os.homedir(), ".tellus", "transform-deps");

export interface RepoDeps {
  /** The per-repo deps dir (on PYTHONPATH for the driver), or null if the repo
   * has no requirements.txt (the shared venv is used as-is). */
  readonly depsDir: string | null;
  /** The python binary for the driver (the shared venv python). */
  readonly python: string;
  readonly error?: string;
}

/**
 * Resolve a per-repo deps dir from the repo's requirements.txt content.
 * - null/empty content -> { depsDir: null } (no per-repo deps; shared venv).
 * - non-empty -> hash -> ~/.tellus/transform-deps/<hash>/ ; if the
 *   `.installed` marker is present, reuse (cached); else `pip install
 *   --target <dir> -r <tempfile>` + write the marker. Returns the dir.
 * Errors are surfaced (pip install of a nonexistent pkg fails loudly).
 */
export function resolveRepoDeps(requirementsContent: string | null | undefined): RepoDeps {
  const python = resolveTransformPython();
  if (!requirementsContent || requirementsContent.trim().length === 0) {
    return { depsDir: null, python };
  }
  const hash = crypto.createHash("sha256").update(requirementsContent).digest("hex").slice(0, 16);
  const depsDir = path.join(DEPS_ROOT, hash);
  const marker = path.join(depsDir, ".installed");
  try {
    fs.mkdirSync(DEPS_ROOT, { recursive: true });
  } catch {
    /* best-effort */
  }
  if (fs.existsSync(marker)) {
    return { depsDir, python };
  }
  // Install into a temp dir first, then rename — a failed/partial install
  // never lands at depsDir (so the cache is never poisoned).
  const staging = `${depsDir}.staging.${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const reqFile = path.join(staging, "requirements.txt");
    fs.writeFileSync(reqFile, requirementsContent);
    const install = spawnSync(python, ["-m", "pip", "install", "--quiet", "--target", staging, "-r", reqFile], {
      timeout: 120_000,
      encoding: "utf8",
    });
    if (install.status !== 0) {
      const tail = (install.stderr || install.stdout || "").trim().split("\n").slice(-3).join(" | ");
      return {
        depsDir: null,
        python,
        error: `per-repo pip install failed (requirements.txt): ${tail || `exit ${install.status}`}`,
      };
    }
    // Write the marker INSIDE staging, then rename staging -> depsDir so the
    // marker moves with the install (depsDir doesn't exist until the rename).
    fs.writeFileSync(path.join(staging, ".installed"), requirementsContent);
    fs.renameSync(staging, depsDir);
    return { depsDir, python };
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { depsDir: null, python, error: `per-repo deps setup failed: ${String(e)}` };
  }
}

/**
 * Preflight the PySpark runtime: the resolved python must run, import
 * pyspark + pandas + pyarrow (with JAVA_HOME set), and the resolved java must
 * run. Returns a clear, actionable error if any step fails — so the build
 * fails loudly at preflight (503 Transform:RuntimeNotConfigured) instead of
 * the cryptic "No module named 'pyspark'" from the child process.
 */
export function preflightTransformRuntime(): RuntimePreflight {
  const python = resolveTransformPython();
  const javaHome = resolveJavaHome();

  // (a) python runs.
  const ver = spawnSync(python, ["--version"], { timeout: 5_000, encoding: "utf8" });
  if (ver.status !== 0) {
    return {
      ok: false,
      python,
      javaHome,
      error: `python runtime '${python}' is not runnable (${ver.error ? String(ver.error) : `exit ${ver.status}`}). Set TELLUS_PYTHON_BIN to a venv with pyspark, or provision one: bash tellus-fe/scripts/verify-transforms-parity.sh`,
    };
  }
  const version = (ver.stdout || ver.stderr || "").trim();

  // (b) import pyspark + pandas + pyarrow (the shim requires all three).
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (javaHome) env.JAVA_HOME = javaHome;
  const imp = spawnSync(python, ["-c", "import pyspark, pandas, pyarrow"], {
    timeout: 30_000,
    encoding: "utf8",
    env,
  });
  if (imp.status !== 0) {
    const errTail = (imp.stderr || imp.stdout || "").trim().split("\n").pop() || "(no output)";
    return {
      ok: false,
      python,
      javaHome,
      version,
      error: `PySpark runtime not configured (python='${python}'): ${errTail}. The transforms.api shim requires pyspark + pandas + pyarrow. Provision: bash tellus-fe/scripts/verify-transforms-parity.sh (creates the venv + installs deps + resolves Java 21).`,
    };
  }

  // (c) java runs (PySpark needs a JVM; 11 is too old for Spark 4, 25 hits
  // getSubject, 21 is known-good).
  if (!javaHome) {
    return {
      ok: false,
      python,
      javaHome,
      version,
      error: `JAVA_HOME not resolved (no openjdk@21/@17 found). PySpark needs Java 17+ (21 known-good; 11 too old; 25 hits getSubject). Install: brew install openjdk@21`,
    };
  }
  const jv = spawnSync(path.join(javaHome, "bin", "java"), ["-version"], { timeout: 5_000, encoding: "utf8" });
  if (jv.status !== 0) {
    return {
      ok: false,
      python,
      javaHome,
      version,
      error: `java '${javaHome}/bin/java' is not runnable (${jv.error ? String(jv.error) : `exit ${jv.status}`}).`,
    };
  }

  return { ok: true, python, javaHome, version };
}
