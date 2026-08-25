// ---------------------------------------------------------------------------
// testRunner.ts — real execution of user-authored tests for functions-publish.
//
// Replaces the old "count the *.test.ts files and call it a pass" test stage.
// Repository function + test sources are transpiled to CommonJS into a fresh
// temp directory and executed with Node's own test runner (`node --test`) in
// a child process. TAP summary lines give deterministic pass/fail counts;
// any non-zero exit, signal, timeout, or malformed output fails the stage.
//
// Test-file convention: *.test.ts / *.test.tsx / *.spec.ts / *.spec.tsx
// importing `node:test` and `node:assert` (a real supported runner — no
// ad-hoc test API). Sources import each other by relative path.
//
// Isolation model (honest scope — see the stage's run-log output):
//   * separate child process, killed as a process GROUP on timeout
//   * wall-clock timeout + V8 heap cap (--max-old-space-size)
//   * minimal env whitelist (same pattern as child-process-sandbox.ts)
//   * per-run temp working directory, removed on every exit path
//   * bounded stdout/stderr capture
// There is NO filesystem or network restriction — the child runs with the
// API process's OS privileges. That matches the level of the existing
// child-process sandbox and is a known limitation, not a sandbox claim.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";

import { RunAuthorityLostError } from "./retry";

export interface TestSourceFile {
  readonly path: string;
  readonly source: string;
}

export interface TestRunResult {
  readonly status: "passed" | "failed";
  readonly fileCount: number;
  readonly testCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Actionable failure lines (bounded), suitable for the run log. */
  readonly failures: readonly string[];
  /** PID of the test child (observability; null if it never spawned). */
  readonly childPid: number | null;
}

export interface TestRunnerTunables {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly killGraceMs: number;
  /** Observability hook invoked with the child PID once spawned. */
  readonly onChildSpawned?: (pid: number) => void;
}

// Named defaults — overridable via env, matching the existing
// FUNCTIONS_PUBLISH_CONCURRENCY convention in service.ts.
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_TEST_MEMORY_MB = 256;
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** Per-stream capture bound; the run log itself truncates at 16 KiB/line. */
export const MAX_CAPTURED_OUTPUT_BYTES = 65_536;
/** Upper bound on failure detail lines returned per run. */
export const MAX_FAILURE_DETAILS = 20;

const TEST_TIMEOUT_BOUNDS = { min: 1_000, max: 600_000 } as const;
const TEST_MEMORY_BOUNDS = { min: 64, max: 4_096 } as const;
const KILL_GRACE_BOUNDS = { min: 100, max: 30_000 } as const;

/** Same minimal-env pattern as orchestration/runners/child-process-sandbox.ts. */
const CHILD_ENV_WHITELIST = new Set(["NODE_ENV", "TZ", "LANG", "PATH", "HOME"]);

export function resolveTestRunnerTunables(
  env: NodeJS.ProcessEnv = process.env,
): TestRunnerTunables {
  return {
    timeoutMs: bounded(env.FUNCTIONS_PUBLISH_TEST_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS, TEST_TIMEOUT_BOUNDS),
    memoryMb: bounded(env.FUNCTIONS_PUBLISH_TEST_MEMORY_MB, DEFAULT_TEST_MEMORY_MB, TEST_MEMORY_BOUNDS),
    killGraceMs: bounded(env.FUNCTIONS_PUBLISH_KILL_GRACE_MS, DEFAULT_KILL_GRACE_MS, KILL_GRACE_BOUNDS),
  };
}

function bounded(
  raw: string | undefined,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const TEST_FILE_PATTERN = /\.(test|spec)\.tsx?$/;

export async function runRepositoryTests(
  files: readonly TestSourceFile[],
  tunables: TestRunnerTunables,
  signal?: AbortSignal,
): Promise<TestRunResult> {
  // Never launch user code after authority is already gone.
  throwIfAborted(signal);
  const testFiles = files.filter((file) => TEST_FILE_PATTERN.test(file.path));
  if (testFiles.length === 0) {
    return {
      status: "passed", fileCount: 0, testCount: 0, passedCount: 0,
      failedCount: 0, durationMs: 0, timedOut: false, failures: [], childPid: null,
    };
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "jemma-test-"));
  try {
    for (const file of files) {
      assertRepoRelativePath(file.path);
      const transpiled = ts.transpileModule(file.source, {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          strict: true,
          esModuleInterop: true,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      const errors = (transpiled.diagnostics ?? [])
        .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
      if (errors.length > 0) {
        return failedResult(testFiles.length, errors.map((diagnostic) =>
          `transpile failed for ${file.path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`));
      }
      const jsPath = join(tmpDir, ...file.path.replace(/\.tsx?$/, ".js").split("/"));
      mkdirSync(dirname(jsPath), { recursive: true });
      writeFileSync(jsPath, transpiled.outputText, "utf8");
    }
    writePlatformModuleStubs(tmpDir);

    const startedAt = Date.now();
    const execution = await executeTestProcess(
      tmpDir,
      testFiles.map((file) => file.path.replace(/\.tsx?$/, ".js")),
      tunables,
      signal,
    );
    // An aborted child is not a test failure — authority was lost;
    // stop without writing a stage result.
    throwIfAborted(signal);
    return toResult(testFiles.length, execution, Date.now() - startedAt);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof RunAuthorityLostError) throw signal.reason;
  throw new RunAuthorityLostError("lease-lost");
}

interface TestProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly childPid: number | null;
}

/**
 * Spawn `node --test` and settle EXACTLY ONCE across the exit/close/error/
 * timeout race. On timeout the child's process group gets SIGTERM, then
 * SIGKILL after the grace period — no orphan subprocess survives.
 */
function executeTestProcess(
  cwd: string,
  testFiles: readonly string[],
  tunables: TestRunnerTunables,
  signal?: AbortSignal,
): Promise<TestProcessOutcome> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (CHILD_ENV_WHITELIST.has(key) && value !== undefined) env[key] = value;
    }
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${tunables.memoryMb}`,
        "--test",
        // Node ≥20 defaults to the spec reporter; pin TAP so the summary
        // parse below has a stable contract.
        "--test-reporter=tap",
        ...testFiles,
      ],
      { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const childPid = child.pid ?? null;
    if (childPid !== null) tunables.onChildSpawned?.(childPid);

    let stdout = "";
    let stderr = "";
    const capture = (chunk: Buffer, current: string): string =>
      current.length >= MAX_CAPTURED_OUTPUT_BYTES
        ? current
        : (current + chunk.toString("utf8")).slice(0, MAX_CAPTURED_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = capture(chunk, stdout); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = capture(chunk, stderr); });

    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const settle = (outcome: Omit<TestProcessOutcome, "timedOut" | "stdout" | "stderr" | "childPid">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...outcome, timedOut, stdout, stderr, childPid });
    };
    const killGroup = (signal_: NodeJS.Signals): void => {
      if (childPid === null) return;
      try {
        // detached: true made the child a process-group leader — signal the
        // whole group so descendant processes cannot outlive the runner.
        process.kill(-childPid, signal_);
      } catch {
        try { child.kill(signal_); } catch { /* already gone */ }
      }
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), tunables.killGraceMs);
    }, tunables.timeoutMs);
    // Authority loss kills the child group immediately — no grace,
    // the lease may already belong to another worker.
    const onAbort = (): void => killGroup("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      stderr += `\nspawn error: ${error.message}`;
      settle({ exitCode: null, signal: null });
    });
    child.once("close", (code, signal_) => settle({ exitCode: code, signal: signal_ }));
  });
}

function toResult(
  fileCount: number,
  outcome: TestProcessOutcome,
  wallClockMs: number,
): TestRunResult {
  const failures: string[] = [];
  const summary = parseTapSummary(outcome.stdout);

  if (outcome.timedOut) {
    failures.push(`test process exceeded its timeout and was killed (signal SIGTERM/SIGKILL)`);
  }
  if (outcome.signal !== null) {
    failures.push(`test process terminated by signal ${outcome.signal}`);
  } else if (outcome.exitCode !== 0) {
    failures.push(`test process exited with code ${outcome.exitCode ?? "unknown"}`);
  }
  if (summary === null) {
    // No TAP summary ⇒ loader/setup crash or malformed output — never pass.
    failures.push("test process produced no parseable TAP summary");
    const tail = tailLines(outcome.stderr || outcome.stdout, 10);
    if (tail) failures.push(tail);
  } else {
    failures.push(...extractTapFailures(outcome.stdout));
  }

  const failedCount = summary?.fail ?? (failures.length > 0 ? 1 : 0);
  return {
    status: failures.length === 0 && summary !== null && summary.fail === 0 ? "passed" : "failed",
    fileCount,
    testCount: summary?.tests ?? 0,
    passedCount: summary?.pass ?? 0,
    failedCount,
    durationMs: summary?.durationMs ?? wallClockMs,
    timedOut: outcome.timedOut,
    failures: failures.slice(0, MAX_FAILURE_DETAILS),
    childPid: outcome.childPid,
  };
}

function failedResult(fileCount: number, failures: string[]): TestRunResult {
  return {
    status: "failed", fileCount, testCount: 0, passedCount: 0,
    failedCount: 1, durationMs: 0, timedOut: false,
    failures: failures.slice(0, MAX_FAILURE_DETAILS), childPid: null,
  };
}

export interface TapSummary {
  readonly tests: number;
  readonly pass: number;
  readonly fail: number;
  readonly durationMs: number;
}

/** Parse the `# tests N` / `# pass N` / `# fail N` TAP summary block. */
export function parseTapSummary(output: string): TapSummary | null {
  const tests = /^# tests (\d+)$/m.exec(output);
  const pass = /^# pass (\d+)$/m.exec(output);
  const fail = /^# fail (\d+)$/m.exec(output);
  const duration = /^# duration_ms ([\d.]+)$/m.exec(output);
  if (!tests || !pass || !fail) return null;
  return {
    tests: Number(tests[1]),
    pass: Number(pass[1]),
    fail: Number(fail[1]),
    durationMs: duration ? Number(duration[1]) : 0,
  };
}

/** Pull `not ok` lines plus the useful diag lines from their YAML blocks. */
function extractTapFailures(output: string): string[] {
  const lines = output.split("\n");
  const failures: string[] = [];
  // Module-load crashes (throw at top level, missing require) are printed
  // as commented stack previews before the failing subtest.
  for (const line of lines) {
    if (/^# (Error|TypeError|ReferenceError|SyntaxError|Cannot find module)[:\s]/.test(line)) {
      failures.push(line.slice(2).trim().slice(0, 512));
    }
    if (failures.length >= MAX_FAILURE_DETAILS) return failures;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("not ok")) continue;
    failures.push(line.trim());
    // TAP diagnostics are a YAML block indented under the not-ok line.
    // Capture scalar keys outright, plus the payload of block scalars
    // (`error: |-` followed by deeper-indented message lines).
    let blockScalarLines = 0;
    for (let look = index + 1; look < Math.min(index + 40, lines.length); look += 1) {
      const diag = lines[look];
      if (diag.startsWith("ok ") || diag.startsWith("not ok") || diag.trim() === "...") break;
      const trimmed = diag.trim();
      if (/^(failureType|error|expected|actual|operator|code):/.test(trimmed)) {
        failures.push(`  ${trimmed}`.slice(0, 512));
        blockScalarLines = trimmed.endsWith("|-") ? 4 : 0;
      } else if (blockScalarLines > 0 && trimmed.length > 0 && diag.startsWith("    ")) {
        failures.push(`  ${trimmed}`.slice(0, 512));
        blockScalarLines -= 1;
      }
      if (failures.length >= MAX_FAILURE_DETAILS) return failures;
    }
  }
  return failures;
}

function tailLines(output: string, count: number): string {
  const lines = output.trim().split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-count).join("\n").slice(0, 2_048);
}

/**
 * Repo paths originate from the Stemma tree; real git trees cannot contain
 * `..` or absolute entries, but never write outside the temp dir on the
 * strength of that — reject traversal defensively.
 */
function assertRepoRelativePath(path: string): void {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`unsafe repository path: ${path}`);
  }
}

/**
 * Platform SDK modules get a stub package whose every export throws a clear
 * error on use — the ontology runtime is not available during CI tests.
 * Pure-function tests never touch these; tests that do fail honestly.
 */
function writePlatformModuleStubs(tmpDir: string): void {
  const specifiers = [
    "@foundry/functions",
    "@foundry/functions-api",
    "@foundry/ontology-api",
    "@ontology/sdk",
    "@osdk/functions",
    "@osdk/client",
  ];
  const indexJs = `\
"use strict";
const unavailable = (name) => function () {
  throw new Error('"' + name + '" is not available in the functions-publish test sandbox');
};
module.exports = new Proxy({}, { get: (_target, prop) => unavailable(String(prop)) });
`;
  for (const specifier of specifiers) {
    const dir = join(tmpDir, "node_modules", ...specifier.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: specifier, main: "index.js" }), "utf8");
    writeFileSync(join(dir, "index.js"), indexJs, "utf8");
  }
}
