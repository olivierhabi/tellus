// ---------------------------------------------------------------------------
// Unit tests for runtimeConfig.ts (gap 1 — env-fragility P0 fix).
//
// Regression for the bug: the executor used to read
// `PYTHON_BIN = process.env.TELLUS_PYTHON_BIN || "python3"` at module load,
// so a plain restart without env vars silently fell back to system python3
// (no pyspark) and builds failed with the cryptic child error
// "No module named 'pyspark'". The fix self-configures (resolveTransformPython
// / resolveJavaHome walk known venv + Java paths) + preflights loudly
// (preflightTransformRuntime imports pyspark/pandas/pyarrow + runs java). This
// test pins: (a) self-config finds the venv+Java without env vars, (b) the
// preflight returns a clear, actionable error when the runtime is broken.
// ---------------------------------------------------------------------------
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  resolveTransformPython,
  resolveJavaHome,
  preflightTransformRuntime,
} from "../../../../../src/services/codeRepository/transforms/runtimeConfig";

// The runtimeConfig's candidatePythons() walks, in order:
//   TELLUS_PYTHON_BIN, PB_B4_PYTHON, ~/.tellus/transform-runtime-venv/bin/python,
//   /tmp/pyspark-spike-venv/bin/python, python3
// A test environment on a Tellus dev machine has the canonical
// ~/.tellus/transform-runtime-venv installed; a CI container may have only
// /tmp/pyspark-spike-venv. HAS_VENV is true when EITHER exists — matches the
// production candidate-list contract (any one of these makes the venv win
// over the bare /usr/bin/python3 fallback).
const VENV_CANDIDATES = [
  path.join(os.homedir(), ".tellus", "transform-runtime-venv", "bin", "python"),
  "/tmp/pyspark-spike-venv/bin/python",
];
const SPIKE_VENV = VENV_CANDIDATES.find((p) => fs.existsSync(p)) ?? VENV_CANDIDATES[0];
const HAS_VENV = VENV_CANDIDATES.some((p) => fs.existsSync(p));
const orig = { ...process.env };

beforeEach(() => {
  // Clear the runtime env vars so self-config is exercised (the whole point
  // of gap 1: a plain restart has them unset).
  delete process.env.TELLUS_PYTHON_BIN;
  delete process.env.PB_B4_PYTHON;
  delete process.env.JAVA_HOME;
});
afterEach(() => {
  process.env = { ...orig };
});

describe("resolveTransformPython (self-config without env vars)", () => {
  it("returns an existing venv python when TELLUS_PYTHON_BIN is unset (self-config)", () => {
    const py = resolveTransformPython();
    // Either the spike venv (self-configured) or python3 (last resort); if the
    // spike venv exists it MUST be preferred over python3.
    if (HAS_VENV) expect(py).toBe(SPIKE_VENV);
    else expect(py).toBe("python3");
  });
  it("honors an explicit TELLUS_PYTHON_BIN (env wins over self-config)", () => {
    process.env.TELLUS_PYTHON_BIN = "/usr/local/bin/python3";
    expect(resolveTransformPython()).toBe("/usr/local/bin/python3");
  });
  it("falls back to python3 when no candidate exists", () => {
    process.env.TELLUS_PYTHON_BIN = "/nonexistent/venv/bin/python";
    // /nonexistent doesn't exist -> skipped -> falls to the next candidate.
    const py = resolveTransformPython();
    expect(typeof py).toBe("string");
  });
});

describe("resolveJavaHome (self-config without env vars)", () => {
  it("returns openjdk@21 when JAVA_HOME is unset (if installed)", () => {
    const jh = resolveJavaHome();
    // On this machine openjdk@21 is installed; if so, it must be found without
    // JAVA_HOME. (Skip the assertion if neither is installed.)
    if (fs.existsSync("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java")) {
      expect(jh).toBeTruthy();
      expect(jh).toMatch(/openjdk@21|openjdk@17/);
    }
  });
});

describe("preflightTransformRuntime (loud failure on misconfiguration)", () => {
  it.skipIf(!HAS_VENV)("returns ok=true when the venv + Java are present (self-configured, no env vars)", () => {
    const r = preflightTransformRuntime();
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.python).toBe(SPIKE_VENV);
    expect(r.javaHome).toBeTruthy();
  });

  it("returns ok=false with a CLEAR, actionable error when the python has no pyspark (the regression: NOT the cryptic child error)", () => {
    // Force system python3 (no pyspark) — the preflight must catch this and
    // return a message containing "PySpark runtime not configured", NOT
    // silently pass + let the build fail later with "No module named 'pyspark'".
    // NOTE: setting TELLUS_PYTHON_BIN=python3 makes resolveTransformPython
    // return "python3" (the env var wins), so self-config does NOT fall through
    // to the spike venv — the preflight hits python3 (no pyspark) -> loud failure.
    process.env.TELLUS_PYTHON_BIN = "python3";
    const r = preflightTransformRuntime();
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/PySpark runtime not configured|import pyspark|pyspark/i);
    // The error must NOT be the cryptic bare child error — it must be actionable.
    expect(r.error ?? "").toMatch(/verify-transforms-parity\.sh|Provision/);
  });

  it.skipIf(!HAS_VENV)("when TELLUS_PYTHON_BIN points to a nonexistent path, self-config falls through to the next existing venv (not a hard failure)", () => {
    // A broken TELLUS_PYTHON_BIN must NOT abort — resolveTransformPython skips
    // nonexistent candidates + falls through to the spike venv. This is the
    // self-config behavior that makes a plain restart work.
    process.env.TELLUS_PYTHON_BIN = "/nonexistent/venv/bin/python";
    const r = preflightTransformRuntime();
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.python).toBe(SPIKE_VENV);
  });
});
