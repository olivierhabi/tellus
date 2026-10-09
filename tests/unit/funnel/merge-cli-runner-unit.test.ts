// ---------------------------------------------------------------------------
// mergeCliRunner — unit tests for the out-of-process DuckDB CLI runner.
//
// No DuckDB binary is required: the runner accepts a `command` override, and
// these tests drive it with a stub Node script. What is pinned here:
//   * settings preamble mirrors pool.ts semantics exactly (memory default,
//     threads emitted ONLY when > 0, insertion-order off, home before temp);
//   * timeout / stall / exit-code failures surface as distinct error types;
//   * timeout and stall actually kill the child: the stub heartbeats to a
//     file, and the heartbeat must FREEZE after the runner kills it;
//   * slow-but-moving work times out (CliTimeoutError), never stalls;
//   * the flag decision function (off / on-without-CLI / on-with-CLI).
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cliSettingsPreamble,
  resolveCliSettings,
  mergeCliTimeoutMs,
  mergeCliStallAfterMs,
  duckDbCliPath,
  isDuckDbCliAvailable,
  resetCliAvailabilityCache,
  runDuckDbCliScript,
  shouldUseOutOfProcessMerge,
  CliTimeoutError,
  CliStallError,
  CliExitError,
  MERGE_CLI_TIMEOUT_MS_DEFAULT,
  type CliProgress,
} from "../../../src/services/funnel/mergeCliRunner";

const ENV_KEYS = [
  "DUCKDB_THREADS",
  "FUNNEL_MERGE_CLI_TIMEOUT_MS",
  "FUNNEL_STAGE_STALL_AFTER_MS",
  "STUB_BEHAVIOR",
  "STUB_SPILL",
  "STUB_OUT",
  "STUB_ALIVE",
];

/** Versioned-config identities (no per-knob env overrides). */
const TEST_ENV = {
  NODE_ENV: "test",
  TELLUS_ENVIRONMENT_ID: "tellus-tests-main",
} as NodeJS.ProcessEnv;
const PROD_ENV = { TELLUS_DEPLOYMENT_STRICT: "1" } as NodeJS.ProcessEnv;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetCliAvailabilityCache();
});

let stubJs = "";
let probeSh = "";

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-stub-"));
  stubJs = path.join(dir, "stub.cjs");
  // Single-process stub (no grandchildren — killing it is clean). Consumes
  // the SQL on stdin, then behaves per STUB_BEHAVIOR:
  //   ok       — write spill + watched output, exit 0
  //   exit1    — stderr complaint, exit 1
  //   sleep    — heartbeat, then sit 60 s (timeout test: must be killed)
  //   slowdrip — heartbeat + grow spill every 200 ms for 60 s
  //              (timeout test: moving work must NOT be called a stall)
  //   idle     — heartbeat, write nothing, sit 60 s (stall test)
  fs.writeFileSync(
    stubJs,
    `const fs = require("node:fs");
let body = "";
process.stdin.on("data", (c) => (body += c));
process.stdin.on("end", main);
process.stdin.resume();
function beat() {
  if (process.env.STUB_ALIVE) {
    try { fs.writeFileSync(process.env.STUB_ALIVE, String(Date.now())); } catch {}
  }
}
function main() {
  const b = process.env.STUB_BEHAVIOR;
  beat();
  const timer = setInterval(beat, 100);
  timer.unref();
  if (b === "ok") {
    fs.mkdirSync(process.env.STUB_SPILL, { recursive: true });
    fs.writeFileSync(process.env.STUB_SPILL + "/f.tmp", "spill-data");
    fs.writeFileSync(process.env.STUB_OUT, "out");
    process.exit(0);
  }
  if (b === "exit1") {
    process.stderr.write("Parser Error: syntax error at line 42\\n");
    process.exit(1);
  }
  if (b === "slowdrip") {
    fs.mkdirSync(process.env.STUB_SPILL, { recursive: true });
    setInterval(() => {
      try { fs.appendFileSync(process.env.STUB_SPILL + "/f.tmp", "x"); } catch {}
    }, 200);
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  // sleep | idle — sit until killed. The timer is REF'd: it is what keeps
  // the stub alive (an unref'd-only stub would exit immediately and the
  // timeout/stall tests would pass vacuously).
  setTimeout(() => process.exit(0), 60_000);
}
`,
  );
  // Minimal executable for the --version availability probe (exits 0 for
  // any args). /bin/true does not exist on macOS, so mint our own.
  probeSh = path.join(path.dirname(stubJs), "probe.sh");
  fs.writeFileSync(probeSh, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(probeSh, 0o755);
});

function workDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
}

/** Point the stub at this run's dirs via process env (inherited by spawn). */
function armStub(behavior: string, wd: string): void {
  process.env.STUB_BEHAVIOR = behavior;
  process.env.STUB_SPILL = path.join(wd, "spill");
  process.env.STUB_OUT = path.join(wd, "out.parquet");
  process.env.STUB_ALIVE = path.join(wd, "alive.txt");
}

function aliveMtime(wd: string): number {
  try {
    return fs.statSync(path.join(wd, "alive.txt")).mtimeMs;
  } catch {
    return -1;
  }
}

describe("cliSettingsPreamble", () => {
  it("mirrors pool.ts: versioned memory default, threads omitted when unset/0, order home/memory/temp/preserve", () => {
    delete process.env.DUCKDB_THREADS;
    const pre = cliSettingsPreamble(resolveCliSettings("/tmp/spill", "/tmp/home", TEST_ENV));
    const lines = pre.trim().split("\n");
    expect(lines[0]).toBe("SET home_directory='/tmp/home';");
    expect(lines[1]).toBe("SET memory_limit='1GB';");
    expect(lines[2]).toBe("PRAGMA temp_directory='/tmp/spill';");
    // No SET threads line: DuckDB auto must not be overridden with 0.
    expect(pre).not.toContain("SET threads");
    expect(lines[lines.length - 1]).toBe("SET preserve_insertion_order=false;");
  });

  it("emits SET threads only when DUCKDB_THREADS is positive", () => {
    process.env.DUCKDB_THREADS = "4";
    expect(
      cliSettingsPreamble(resolveCliSettings("/tmp/spill", "/tmp/home", TEST_ENV)),
    ).toContain("SET threads=4;");
    process.env.DUCKDB_THREADS = "0";
    expect(
      cliSettingsPreamble(resolveCliSettings("/tmp/spill", "/tmp/home", TEST_ENV)),
    ).not.toContain("SET threads");
    process.env.DUCKDB_THREADS = "junk";
    expect(
      cliSettingsPreamble(resolveCliSettings("/tmp/spill", "/tmp/home", TEST_ENV)),
    ).not.toContain("SET threads");
  });

  it("uses versioned memory per profile and quotes paths", () => {
    const pre = cliSettingsPreamble(
      resolveCliSettings("/tmp/o'brien", "/tmp/home", PROD_ENV),
    );
    expect(pre).toContain("SET memory_limit='8GB';");
    expect(pre).toContain("PRAGMA temp_directory='/tmp/o''brien';");
  });
});

describe("env parsing", () => {
  it("mergeCliTimeoutMs is versioned (30 min) and ignores the retired env knob", () => {
    delete process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS;
    expect(mergeCliTimeoutMs()).toBe(MERGE_CLI_TIMEOUT_MS_DEFAULT);
    expect(MERGE_CLI_TIMEOUT_MS_DEFAULT).toBe(30 * 60 * 1000);
    expect(mergeCliTimeoutMs(TEST_ENV)).toBe(MERGE_CLI_TIMEOUT_MS_DEFAULT);
    expect(mergeCliTimeoutMs(PROD_ENV)).toBe(MERGE_CLI_TIMEOUT_MS_DEFAULT);
    process.env.FUNNEL_MERGE_CLI_TIMEOUT_MS = "60000";
    expect(mergeCliTimeoutMs()).toBe(MERGE_CLI_TIMEOUT_MS_DEFAULT);
  });

  it("mergeCliStallAfterMs is the versioned stage stall budget (60 s)", () => {
    process.env.FUNNEL_STAGE_STALL_AFTER_MS = "1";
    expect(mergeCliStallAfterMs()).toBe(60_000);
    expect(mergeCliStallAfterMs(PROD_ENV)).toBe(60_000);
  });

  it("duckDbCliPath comes from the versioned profile", () => {
    expect(duckDbCliPath(TEST_ENV)).toBe("duckdb");
    expect(duckDbCliPath(PROD_ENV)).toBe("/usr/local/bin/duckdb");
  });
});

describe("shouldUseOutOfProcessMerge", () => {
  it("test profile => in-process", async () => {
    await expect(shouldUseOutOfProcessMerge(TEST_ENV)).resolves.toEqual({
      outOfProcess: false,
      reason: "flag-off",
    });
  });

  it("production profile but no CLI => in-process with cli-missing", async () => {
    resetCliAvailabilityCache();
    await expect(
      shouldUseOutOfProcessMerge(PROD_ENV, "/nonexistent/duckdb-binary-xyz"),
    ).resolves.toEqual({
      outOfProcess: false,
      reason: "cli-missing",
    });
  });

  it("production profile with a runnable CLI => out-of-process", async () => {
    resetCliAvailabilityCache();
    // probeSh ignores --version and exits 0: proves the probe runs the
    // configured binary without needing a real DuckDB here.
    await expect(
      shouldUseOutOfProcessMerge(PROD_ENV, probeSh),
    ).resolves.toEqual({
      outOfProcess: true,
      reason: "flag-on-cli-available",
    });
  });

  it("isDuckDbCliAvailable never throws and caches per path", async () => {
    resetCliAvailabilityCache();
    await expect(isDuckDbCliAvailable(probeSh)).resolves.toBe(true);
    await expect(isDuckDbCliAvailable(probeSh)).resolves.toBe(true);
    resetCliAvailabilityCache();
    await expect(
      isDuckDbCliAvailable("/nonexistent/duckdb-binary-xyz"),
    ).resolves.toBe(false);
  });
});

describe("runDuckDbCliScript", () => {
  it("success: writes script.sql, returns timings, reports progress", async () => {
    const wd = workDir();
    armStub("ok", wd);
    const seen: CliProgress[] = [];
    const res = await runDuckDbCliScript({
      scriptText: "SELECT 42;\n",
      workDir: wd,
      spillDir: path.join(wd, "spill"),
      watchPaths: [path.join(wd, "out.parquet")],
      timeoutMs: 30_000,
      stallAfterMs: 10_000,
      pollMs: 25,
      command: [process.execPath, stubJs],
      onProgress: (p) => seen.push(p),
    });
    expect(fs.readFileSync(path.join(wd, "script.sql"), "utf8")).toBe(
      "SELECT 42;\n",
    );
    expect(fs.existsSync(path.join(wd, "stdout.log"))).toBe(true);
    expect(fs.existsSync(path.join(wd, "stderr.log"))).toBe(true);
    expect(res.wallMs).toBeGreaterThanOrEqual(0);
    expect(res.peakSpillBytes).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1].spillBytes).toBeGreaterThan(0);
  }, 30_000);

  it("a throwing onProgress neither kills the watchdog nor fails the run, and is logged", async () => {
    // Liveness reporting is best-effort: a throwing progress callback must
    // not escape the watchdog interval (uncaught in a timer = dead
    // watchdog / crashed process). The throw must be logged, not swallowed.
    const wd = workDir();
    armStub("ok", wd);
    const warnings: unknown[][] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      warnings.push(a);
    };
    try {
      let calls = 0;
      const res = await runDuckDbCliScript({
        scriptText: "SELECT 42;\n",
        workDir: wd,
        spillDir: path.join(wd, "spill"),
        watchPaths: [path.join(wd, "out.parquet")],
        timeoutMs: 30_000,
        stallAfterMs: 10_000,
        pollMs: 25,
        command: [process.execPath, stubJs],
        onProgress: () => {
          calls++;
          throw new Error("boom from progress");
        },
      });
      expect(res.wallMs).toBeGreaterThanOrEqual(0);
      expect(res.peakSpillBytes).toBeGreaterThan(0);
      expect(calls).toBeGreaterThan(0);
      expect(
        warnings.some(
          (a) =>
            String(a[0]).includes("[merge-cli]") &&
            String(a[0]).includes("onProgress"),
        ),
      ).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  }, 30_000);

  it("nonzero exit => CliExitError carrying the stderr tail", async () => {
    const wd = workDir();
    armStub("exit1", wd);
    const err = await runDuckDbCliScript({
      scriptText: "BAD SQL",
      workDir: wd,
      spillDir: path.join(wd, "spill"),
      timeoutMs: 30_000,
      stallAfterMs: 10_000,
      pollMs: 25,
      command: [process.execPath, stubJs],
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliExitError);
    expect((err as CliExitError).exitCode).toBe(1);
    expect((err as CliExitError).stderrTail).toContain("syntax error");
    expect((err as CliExitError).workDir).toBe(wd);
  }, 30_000);

  it("timeout => CliTimeoutError and the child heartbeat freezes (it is dead)", async () => {
    const wd = workDir();
    armStub("sleep", wd);
    const err = await runDuckDbCliScript({
      scriptText: "SELECT pg_sleep(60);",
      workDir: wd,
      spillDir: path.join(wd, "spill"),
      timeoutMs: 500,
      stallAfterMs: 60_000,
      pollMs: 25,
      killGraceMs: 200,
      command: [process.execPath, stubJs],
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliTimeoutError);
    // A live child would keep heartbeating every 100 ms. Freeze proves death.
    const t1 = aliveMtime(wd);
    expect(t1).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1200));
    expect(aliveMtime(wd)).toBe(t1);
  }, 30_000);

  it("moving work times out but never stalls", async () => {
    const wd = workDir();
    armStub("slowdrip", wd);
    const err = await runDuckDbCliScript({
      scriptText: "SELECT slow();",
      workDir: wd,
      spillDir: path.join(wd, "spill"),
      timeoutMs: 1500,
      stallAfterMs: 10_000,
      pollMs: 25,
      killGraceMs: 200,
      command: [process.execPath, stubJs],
    }).then(
      () => null,
      (e) => e,
    );
    // Spill grows every 200 ms, so the stall watchdog must NOT fire — the
    // hard timeout is what ends it.
    expect(err).toBeInstanceOf(CliTimeoutError);
    expect(err).not.toBeInstanceOf(CliStallError);
  }, 30_000);

  it("idle child => CliStallError and the child heartbeat freezes", async () => {
    const wd = workDir();
    armStub("idle", wd);
    const err = await runDuckDbCliScript({
      scriptText: "SELECT wedged();",
      workDir: wd,
      spillDir: path.join(wd, "spill"),
      timeoutMs: 60_000,
      stallAfterMs: 400,
      pollMs: 50,
      killGraceMs: 200,
      command: [process.execPath, stubJs],
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CliStallError);
    const t1 = aliveMtime(wd);
    expect(t1).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1200));
    expect(aliveMtime(wd)).toBe(t1);
  }, 30_000);
});
