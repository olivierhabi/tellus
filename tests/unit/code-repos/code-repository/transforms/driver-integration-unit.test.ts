// ---------------------------------------------------------------------------
// Driver-level integration tests for pythonRuntime.ts (the emitted
// transforms.api shim + driver.py). These run the REAL Python — they write
// TRANSFORMS_API_PY + DRIVER_PY to a temp workdir, spawn the PySpark venv
// python, and assert the JSON-over-stdout result. They cover the logic
// branches that pure-TS tests can't reach:
//
//   - the Foundry ctx-injection rule (ctx first for @incremental and
//     @transform_df/@transform_pandas; NO ctx for non-incremental @transform);
//   - Output.write_dataframe dispatch (stdlib DataFrame -> CSV via pandas);
//   - Output.set_mode reflected in the result.mode;
//   - failure paths: mode='previous' before any prior transaction (must
//     raise, not silently read the current tx), a transform that raises
//     mid-write (driver returns {ok:false} -> buildService skips
//     materializeOutput, no half-commit), and a transform that exceeds the
//     timeout (SIGKILL -> exec.timedOut).
//
// Skipped automatically when the PySpark venv is absent (CI without the
// runtime). Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import {
  TRANSFORMS_API_PY,
  DRIVER_PY,
} from "../../../../../src/services/codeRepository/transforms/runtime/pythonRuntime";
import { executeTransform } from "../../../../../src/services/codeRepository/transforms/executor";
import type { DiscoveredTransform } from "../../../../../src/services/codeRepository/transforms/discovery";

// Resolve the PySpark venv python (the same one the bash runner provisions).
const VENV_PY =
  process.env.TELLUS_PYTHON_BIN ||
  [
    `${process.env.HOME}/.tellus/transform-runtime-venv/bin/python`,
    "/tmp/pyspark-spike-venv/bin/python",
  ].find((p) => p && fs.existsSync(p)) ||
  "";
const HAS_VENV = VENV_PY !== "" && fs.existsSync(VENV_PY);

// A discovered-transform stub the executor accepts.
const dt = (name: string, outputRid: string, inputs: { param: string; rid: string }[] = []): DiscoveredTransform => ({
  name,
  sourcePath: `transforms/${name}.py`,
  kind: "transform",
  outputRid,
  inputs: inputs.map((i) => ({ param: i.param, rid: i.rid })),
  incremental: false,
});

// Run driver.py against a user transform module + job. Returns the parsed
// JSON result (or {ok:false, stdout, stderr} on parse failure).
function runDriver(
  userPy: string,
  job: { entryPoint: string; isIncremental?: boolean; inputs?: { param: string; rid: string; path: string; previousPath?: string | null }[] },
): { ok: boolean; result?: { rowCount: number; columns: string[]; mode: string }; error?: string; stdout: string; stderr: string } {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "drv-"));
  fs.mkdirSync(path.join(workdir, "sdk", "transforms"), { recursive: true });
  fs.writeFileSync(path.join(workdir, "sdk", "transforms", "__init__.py"), "");
  fs.writeFileSync(path.join(workdir, "sdk", "transforms", "api.py"), TRANSFORMS_API_PY);
  fs.writeFileSync(path.join(workdir, "driver.py"), DRIVER_PY);
  fs.writeFileSync(path.join(workdir, "user.py"), userPy);
  const outputPath = path.join(workdir, "out.csv");
  // Stage any input CSVs the job references.
  for (const inp of job.inputs ?? []) {
    if (inp.path && !fs.existsSync(inp.path)) {
      fs.mkdirSync(path.dirname(inp.path), { recursive: true });
      fs.writeFileSync(inp.path, "id,v\n1,10\n2,20\n");
    }
  }
  const fullJob = {
    sdkRoot: path.join(workdir, "sdk"),
    modulePath: path.join(workdir, "user.py"),
    entryPoint: job.entryPoint,
    outputPath,
    isIncremental: job.isIncremental ?? false,
    inputs: job.inputs ?? [],
  };
  const r = spawnSync(VENV_PY, [path.join(workdir, "driver.py")], {
    env: { ...process.env, TELLUS_TRANSFORM_JOB: JSON.stringify(fullJob) },
    encoding: "utf8",
    timeout: 60_000,
  });
  let parsed: { ok: boolean; result?: { rowCount: number; columns: string[]; mode: string }; error?: string } | null = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim());
  } catch {
    parsed = { ok: false };
  }
  return { ...parsed!, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// ===========================================================================
// ctx-injection rule (the core of the Incremental gap closure). Foundry:
// ctx is the first positional arg for @incremental and for @transform_df /
// @transform_pandas; non-incremental @transform gets NO ctx.
// ===========================================================================
describe.skipIf(!HAS_VENV)("driver ctx-injection rule (pythonRuntime)", () => {
  it("@transform_pandas receives ctx as the first param", () => {
    // If ctx were NOT passed, fn(ctx) would be called as fn() -> TypeError.
    const py = `from transforms.api import transform_pandas, Output, DataFrame
@transform_pandas(output=Output("ri.foundry.main.dataset.a"))
def f(ctx):
    return DataFrame([{"k": 1}])
`;
    const r = runDriver(py, { entryPoint: "f" });
    expect(r.ok, `stderr: ${r.stderr}`).toBe(true);
    expect(r.result?.rowCount).toBe(1);
  });

  it("@incremental @transform receives ctx as the first param", () => {
    // Signature (ctx, output). If ctx were not passed, ctx=output, output unset -> TypeError.
    const py = `from transforms.api import incremental, transform, Output, DataFrame
@incremental()
@transform(output=Output("ri.foundry.main.dataset.b"))
def f(ctx, output):
    output.set_mode("replace")
    output.write_dataframe(DataFrame([{"k": "incr"}]))
`;
    const r = runDriver(py, { entryPoint: "f", isIncremental: false });
    expect(r.ok, `stderr: ${r.stderr}`).toBe(true);
    expect(r.result?.mode).toBe("replace");
  });

  it("non-incremental @transform does NOT receive ctx (output is the first param)", () => {
    // Signature (output). If ctx were WRONGLY passed, fn(ctx, output) -> 2 args to 1-arg fn -> TypeError.
    const py = `from transforms.api import transform, Output, DataFrame
@transform(output=Output("ri.foundry.main.dataset.c"))
def f(output):
    output.write_dataframe(DataFrame([{"k": "basic"}]))
`;
    const r = runDriver(py, { entryPoint: "f" });
    expect(r.ok, `stderr: ${r.stderr}`).toBe(true);
    expect(r.result?.rowCount).toBe(1);
  });
});

// ===========================================================================
// write_dataframe dispatch + set_mode (pythonRuntime).
// ===========================================================================
describe.skipIf(!HAS_VENV)("driver write_dataframe + set_mode (pythonRuntime)", () => {
  it("write_dataframe accepts a stdlib DataFrame and writes a CSV (rowCount + columns)", () => {
    const py = `from transforms.api import transform, Output, DataFrame
@transform(output=Output("ri.foundry.main.dataset.d"))
def f(output):
    output.write_dataframe(DataFrame([{"id": 1, "v": 10}, {"id": 2, "v": 20}]))
`;
    const r = runDriver(py, { entryPoint: "f" });
    expect(r.ok, `stderr: ${r.stderr}`).toBe(true);
    expect(r.result?.rowCount).toBe(2);
    expect(r.result?.columns).toEqual(expect.arrayContaining(["id", "v"]));
  });

  it("set_mode('modify') is reflected in result.mode", () => {
    const py = `from transforms.api import transform, Output, DataFrame
@transform(output=Output("ri.foundry.main.dataset.e"))
def f(output):
    output.set_mode("modify")
    output.write_dataframe(DataFrame([{"k": 1}]))
`;
    const r = runDriver(py, { entryPoint: "f" });
    expect(r.ok, `stderr: ${r.stderr}`).toBe(true);
    expect(r.result?.mode).toBe("modify");
  });
});

// ===========================================================================
// Failure paths (the ones the user explicitly asked about).
// ===========================================================================
describe.skipIf(!HAS_VENV)("driver failure paths (pythonRuntime)", () => {
  it("mode='previous' before any prior transaction raises (not silently reads the current tx)", () => {
    // previousPath is null on a first build; _resolved_path('previous') must raise.
    const py = `from transforms.api import transform, Output, Input
@transform(output=Output("ri.foundry.main.dataset.out"), src=Input("ri.foundry.main.dataset.in"))
def f(output, src):
    src.dataframe(mode="previous")  # no prior tx -> must raise
    output.write_dataframe(src.dataframe())
`;
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), "din-"));
    const r = runDriver(py, {
      entryPoint: "f",
      inputs: [{ param: "src", rid: "ri.foundry.main.dataset.in", path: path.join(inputDir, "in.csv"), previousPath: null }],
    });
    expect(r.ok).toBe(false);
    expect((r.error ?? "") + r.stderr).toMatch(/previous|no previous transaction/i);
  });

  it("a transform that raises mid-write returns {ok:false} (buildService then skips materializeOutput -> no half-commit)", () => {
    const py = `from transforms.api import transform, Output, DataFrame
@transform(output=Output("ri.foundry.main.dataset.f"))
def f(output):
    output.write_dataframe(DataFrame([{"k": 1}]))  # writes the output CSV
    raise RuntimeError("boom-after-write")        # then raises
`;
    const r = runDriver(py, { entryPoint: "f" });
    expect(r.ok).toBe(false);
    expect((r.error ?? "") + r.stderr).toMatch(/boom-after-write/);
  });
});

// ===========================================================================
// Timeout — a transform that exceeds timeoutMs is SIGKILLed; executeTransform
// reports timedOut. (Uses system python3 via the executor; no pandas needed —
// the transform sleeps before writing.)
// ===========================================================================
describe("executor timeout (executeTransform SIGKILLs a long-running transform)", () => {
  it("a transform sleeping past timeoutMs -> ok=false, timedOut=true", async () => {
    const py = `from transforms.api import transform, Output, DataFrame
import time
@transform(output=Output("ri.foundry.main.dataset.timeout"))
def f(output):
    time.sleep(5)  # well past the 1s timeout below
    output.write_dataframe(DataFrame([{"k": 1}]))
`;
    const r = await executeTransform({
      transform: dt("f", "ri.foundry.main.dataset.timeout"),
      files: [{ path: "transforms/f.py", content: py }],
      inputs: [],
      timeoutMs: 1_000,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 15_000);
});
