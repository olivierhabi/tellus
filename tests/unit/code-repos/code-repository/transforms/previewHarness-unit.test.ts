// ---------------------------------------------------------------------------
// previewHarness-unit.test.ts — logic tests for runTransformPreview.
//
// previewHarness is orchestration: read committed .py -> merge fileOverrides
// (unsaved drafts) -> discover -> resolve REAL inputs (resolveDatasetByRid,
// read-only) -> executeTransform (real PySpark sandbox) -> readCSV the output
// -> cleanup the temp dir -> PreviewResult — with NO materializeOutput (no
// committed dataset_transaction). These tests pin that control flow + the
// PreviewResult contract + engine mapping + error paths, with the heavy deps
// mocked (executor / datasetStore / testHarness.readRepoPyFiles /
// runtimeConfig.preflight / discovery). readCSV runs REAL against staged CSVs
// so the read-back + cleanup are exercised truthfully.
//
// The real PySpark execution path is covered end-to-end by the E2E
// (POST /code-repositories/:rid/transforms/preview against a seeded repo) +
// driver-integration-unit.test.ts (the shim/driver). Run:
//   npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Hoisted mocks. Factories only provide vi.fn() stubs; beforeEach wires the
// implementations (factories run before outer vars are initialized).
vi.mock("../../../../../src/services/codeRepository/transforms/executor.js", () => ({
  executeTransform: vi.fn(),
}));
vi.mock("../../../../../src/services/codeRepository/transforms/datasetStore.js", () => ({
  resolveTransformInput: vi.fn(),
}));
vi.mock("../../../../../src/services/codeRepository/transforms/testHarness.js", () => ({
  readRepoPyFiles: vi.fn(),
}));
vi.mock("../../../../../src/services/codeRepository/transforms/runtimeConfig.js", () => ({
  preflightTransformRuntime: vi.fn(),
}));
vi.mock("../../../../../src/services/codeRepository/transforms/discovery.js", () => ({
  discoverTransforms: vi.fn(),
}));

import { runTransformPreview, sanitizeFileOverrides } from "../../../../../src/services/codeRepository/transforms/previewHarness";
import { executeTransform } from "../../../../../src/services/codeRepository/transforms/executor";
import { resolveTransformInput } from "../../../../../src/services/codeRepository/transforms/datasetStore";
import { readRepoPyFiles } from "../../../../../src/services/codeRepository/transforms/testHarness";
import { preflightTransformRuntime } from "../../../../../src/services/codeRepository/transforms/runtimeConfig";
import { discoverTransforms } from "../../../../../src/services/codeRepository/transforms/discovery";
import type { DiscoveredTransform, TransformKind } from "../../../../../src/services/codeRepository/transforms/discovery";
import type { ExecuteResult } from "../../../../../src/services/codeRepository/transforms/executor";

const RID = "ri.stemma.main.repository.055419ff-9dc1-4328-b731-1757dea114f2";
const INPUT_RID = "ri.foundry.main.dataset.orders-raw-8ded8dae";
// P0 authz: superadmin bypass skips the input read-check (no DB hit) — this
// test pins the preview control flow, not authz.
const SUPERADMIN = { userId: "test-superadmin", roles: ["tellus-superadmin"] };
const OUTPUT_RID = "ri.foundry.main.dataset.spark-preview-out";
// A Foundry-catalog CSV input (foundry_datasets.id UUID suffix).
const FOUNDRY_INPUT_RID = "ri.foundry.main.dataset.c3a54ed5-19a3-4394-a66b-7e8b0d5dee95";

// Staged CSVs (readCSV reads these for real).
const INPUT_CSV = "order_id,customer,amount,status\n1,alice,120,completed\n2,bob,0,cancelled\n3,carol,80,completed\n";
// The transform's "output" (filter completed + amount*2): alice 240, carol 160.
const OUTPUT_CSV = "order_id,customer,amount,status\n1,alice,240,completed\n3,carol,160,completed\n";

const dt = (kind: TransformKind, name: string, outputRid: string, inputs: { param: string; rid: string }[]): DiscoveredTransform => ({
  name,
  sourcePath: `src/transform-05/datasets/${name}.py`,
  kind,
  outputRid,
  inputs: inputs.map((i) => ({ param: i.param, rid: i.rid })),
  incremental: false,
  profile: null,
});

const sparkTransform = dt("transform_df", "spark_transform", OUTPUT_RID, [{ param: "orders", rid: INPUT_RID }]);
const lightweightTransform = dt("transform_pandas", "lightweight_transform", "ri.foundry.main.dataset.lightweight-preview-out", [{ param: "orders", rid: INPUT_RID }]);

const mockedExecute = executeTransform as unknown as { mockImplementation: (fn: (a: unknown) => Promise<ExecuteResult>) => void; mock: unknown };
const mockedResolve = resolveTransformInput as unknown as { mockImplementation: (fn: (rid: string, branch?: string) => Promise<unknown>) => void };
const mockedReadRepo = readRepoPyFiles as unknown as { mockImplementation: (fn: (...a: unknown[]) => Promise<unknown>) => void };
const mockedPreflight = preflightTransformRuntime as unknown as { mockImplementation: (fn: () => unknown) => void };
const mockedDiscover = discoverTransforms as unknown as { mockImplementation: (fn: (files: unknown) => unknown) => void; mock: { calls: unknown[][] } };

let tmpRoot: string;
const createdOutDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preview-test-"));
  createdOutDirs.length = 0;

  // Staged input CSV (resolveDatasetByRid points here).
  const inputPath = path.join(tmpRoot, "input.csv");
  fs.writeFileSync(inputPath, INPUT_CSV);

  mockedPreflight.mockImplementation(() => ({ ok: true, python: "python3", javaHome: "/j", version: "3.x" }));
  mockedReadRepo.mockImplementation(async () => ({
    files: [{ path: "src/transform-05/datasets/spark_transform.py", content: "# committed stub" }],
    kind: "ok",
  }));
  mockedDiscover.mockImplementation(() => ({ transforms: [sparkTransform], errors: [] }));
  mockedResolve.mockImplementation(async () => ({ datasetId: "ds-1", filePath: inputPath, fileFormat: "csv", stagedPath: null, origin: "dataset-table" }));
  // executeTransform mock: create a temp out dir, write the "output" CSV there,
  // return ExecuteResult pointing at it (so the real readCSV reads it back +
  // the harness cleans the dir up).
  mockedExecute.mockImplementation(async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-preview-out-"));
    createdOutDirs.push(outDir);
    const outputPath = path.join(outDir, "output.csv");
    fs.writeFileSync(outputPath, OUTPUT_CSV);
    const res: ExecuteResult = {
      ok: true, outputPath, rowCount: 2, columns: ["order_id", "customer", "amount", "status"],
      writeMode: "replace", stdout: "", stderr: "", error: null, traceback: null, timedOut: false, durationMs: 5,
    };
    return res;
  });
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const d of createdOutDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

const runPreview = (overrides?: Record<string, string>) =>
  runTransformPreview({
    stemma: {} as never,
    repositoryRid: RID,
    branch: "main",
    entryPoint: "spark_transform",
    fileOverrides: overrides,
    principal: SUPERADMIN,
  });

describe("runTransformPreview — happy path", () => {
  it("runs a spark @transform_df against real inputs + returns sample output rows (no commit)", async () => {
    const r = await runPreview();
    expect(r.ok).toBe(true);
    expect(r.entryPoint).toBe("spark_transform");
    expect(r.engine).toBe("spark");
    // Input sample read back from the resolved real CSV.
    expect(r.inputs).toHaveLength(1);
    expect(r.inputs[0]).toMatchObject({ param: "orders", rid: INPUT_RID });
    expect(r.inputs[0].columns).toEqual(["order_id", "customer", "amount", "status"]);
    expect(r.inputs[0].rowCount).toBe(3);
    // Output sample read back from the executor's output CSV.
    expect(r.output).not.toBeNull();
    expect(r.output!.rid).toBe(OUTPUT_RID);
    expect(r.output!.columns).toEqual(["order_id", "customer", "amount", "status"]);
    expect(r.output!.rowCount).toBe(2);
    expect(r.output!.rows[0]).toMatchObject({ customer: "alice", amount: "240" });
    expect(r.output!.rows[1]).toMatchObject({ customer: "carol", amount: "160" });
    // executeTransform called with isIncremental=false + an explicit timeout < the HTTP budget.
    const call = (executeTransform as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      isIncremental?: boolean; timeoutMs?: number; inputs: Array<{ path: string; previousPath: string | null }>;
    };
    expect(call.isIncremental).toBe(false);
    expect(call.timeoutMs).toBeLessThan(120_000);
    expect(call.inputs[0].path).toBe(path.join(tmpRoot, "input.csv")); // the REAL resolved file
    expect(call.inputs[0].previousPath).toBeNull();
  });

  it("maps @transform_pandas -> engine 'pandas' (lightweight, no SparkSession)", async () => {
    mockedDiscover.mockImplementation(() => ({ transforms: [lightweightTransform], errors: [] }));
    const r = await runTransformPreview({
      stemma: {} as never, repositoryRid: RID, branch: "main", entryPoint: "lightweight_transform",
      principal: SUPERADMIN,
    });
    expect(r.ok).toBe(true);
    expect(r.engine).toBe("pandas");
  });

  it("reads back at most PREVIEW_SAMPLE_ROWS (100) rows", async () => {
    // Build a 250-row output CSV; readCSV(maxRows:100) returns 100.
    const bigRows = Array.from({ length: 250 }, (_, i) => `${i},c${i},${i * 10},completed`).join("\n");
    mockedExecute.mockImplementation(async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-preview-out-"));
      createdOutDirs.push(outDir);
      const outputPath = path.join(outDir, "output.csv");
      fs.writeFileSync(outputPath, `order_id,customer,amount,status\n${bigRows}\n`);
      return { ok: true, outputPath, rowCount: 250, columns: ["order_id", "customer", "amount", "status"], writeMode: "replace", stdout: "", stderr: "", error: null, traceback: null, timedOut: false, durationMs: 5 } as ExecuteResult;
    });
    const r = await runPreview();
    expect(r.ok).toBe(true);
    // readCSV(maxRows:100) caps both rowCount + rows at 100 (the CSV has 250
    // data rows); a preview shows a sample, not the full table.
    expect(r.output!.rows.length).toBe(100);
    expect(r.output!.rowCount).toBe(100);
  });

  it("cleans up the executor's tellus-transform-out-* temp dir", async () => {
    await runPreview();
    expect(createdOutDirs.length).toBeGreaterThan(0);
    for (const d of createdOutDirs) expect(fs.existsSync(d)).toBe(false);
  });
});

describe("runTransformPreview — Foundry-catalog input (foundry_datasets bridge)", () => {
  // resolveTransformInput bridges the `dataset`-table miss to foundry_datasets:
  // a catalog CSV Input("ri.foundry.main.dataset.<uuid>") is streamed to a temp
  // CSV the driver reads, then cleaned up. These pin the bridge + the no-leak
  // cleanup on both the success path + the partial-resolution failure path.
  it("stages a foundry-bridge input to a temp CSV + cleans it up (no leak)", async () => {
    const foundryTransform = dt("transform_df", "spark_transform", OUTPUT_RID, [{ param: "orders", rid: FOUNDRY_INPUT_RID }]);
    mockedDiscover.mockImplementation(() => ({ transforms: [foundryTransform], errors: [] }));

    // Stage a temp CSV as the foundry-bridge input (mimics stageFoundryInputToCsv).
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-foundry-staged-"));
    createdOutDirs.push(stagedDir);
    const stagedPath = path.join(stagedDir, "input.csv");
    fs.writeFileSync(stagedPath, INPUT_CSV);
    mockedResolve.mockImplementation(async () => ({
      datasetId: "c3a54ed5-19a3-4394-a66b-7e8b0d5dee95",
      filePath: stagedPath,
      fileFormat: "csv",
      stagedPath,
      origin: "foundry-bridge",
    }));

    const r = await runTransformPreview({
      stemma: {} as never, repositoryRid: RID, branch: "main", entryPoint: "spark_transform",
    });
    expect(r.ok).toBe(true);
    // The driver received the STAGED temp path (not a dataset-table file).
    const call = (executeTransform as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as { inputs: Array<{ path: string }> };
    expect(call.inputs[0].path).toBe(stagedPath);
    // Input sample was read back from the staged CSV.
    expect(r.inputs[0].rid).toBe(FOUNDRY_INPUT_RID);
    expect(r.inputs[0].rowCount).toBe(3);
    // The staged temp dir is cleaned after the preview (no leak).
    expect(fs.existsSync(stagedDir)).toBe(false);
  });

  it("cleans a foundry-bridge input staged before a LATER input fails to resolve", async () => {
    // Two inputs: input[0] is a foundry-bridge CSV (staged), input[1] is missing.
    const twoInputTransform = dt("transform_df", "two_inputs", OUTPUT_RID, [
      { param: "orders", rid: FOUNDRY_INPUT_RID },
      { param: "missing", rid: "ri.foundry.main.dataset.00000000-0000-0000-0000-000000000000" },
    ]);
    mockedDiscover.mockImplementation(() => ({ transforms: [twoInputTransform], errors: [] }));

    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-foundry-staged-"));
    createdOutDirs.push(stagedDir);
    const stagedPath = path.join(stagedDir, "input.csv");
    fs.writeFileSync(stagedPath, INPUT_CSV);
    mockedResolve.mockImplementation(async (rid: string) => {
      if (rid === FOUNDRY_INPUT_RID) return { datasetId: "c3a54ed5-19a3-4394-a66b-7e8b0d5dee95", filePath: stagedPath, fileFormat: "csv", stagedPath, origin: "foundry-bridge" };
      return null; // input[1] missing
    });

    const r = await runTransformPreview({ stemma: {} as never, repositoryRid: RID, branch: "main", entryPoint: "two_inputs", principal: SUPERADMIN });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("input dataset not found");
    // input[0]'s staged temp was cleaned even though input[1] failed (no leak
    // on the early-return path through the outer finally).
    expect(fs.existsSync(stagedDir)).toBe(false);
    // executeTransform was never called (resolution failed first).
    expect((executeTransform as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });
});

describe("runTransformPreview — fileOverrides (unsaved draft preview)", () => {
  it("merges fileOverrides over committed files (discover + execute see the draft)", async () => {
    let discoveredFiles: unknown = null;
    let execFiles: unknown = null;
    mockedDiscover.mockImplementation((files: unknown) => { discoveredFiles = files; return { transforms: [sparkTransform], errors: [] }; });
    mockedExecute.mockImplementation(async (a: unknown) => {
      execFiles = (a as { files: unknown }).files;
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-preview-out-"));
      createdOutDirs.push(outDir);
      const outputPath = path.join(outDir, "output.csv");
      fs.writeFileSync(outputPath, OUTPUT_CSV);
      return { ok: true, outputPath, rowCount: 2, columns: ["order_id", "customer", "amount", "status"], writeMode: "replace", stdout: "", stderr: "", error: null, traceback: null, timedOut: false, durationMs: 5 } as ExecuteResult;
    });
    const r = await runPreview({ "src/transform-05/datasets/spark_transform.py": "# UNSAVED DRAFT CONTENT" });
    expect(r.ok).toBe(true);
    const disc = (discoveredFiles as Array<{ path: string; content: string }>).find((f) => f.path === "src/transform-05/datasets/spark_transform.py");
    expect(disc?.content).toBe("# UNSAVED DRAFT CONTENT");
    const exec = (execFiles as Array<{ path: string; content: string }>).find((f) => f.path === "src/transform-05/datasets/spark_transform.py");
    expect(exec?.content).toBe("# UNSAVED DRAFT CONTENT");
  });

  it("adds a not-yet-committed file from fileOverrides", async () => {
    let discoveredFiles: unknown = null;
    mockedDiscover.mockImplementation((files: unknown) => { discoveredFiles = files; return { transforms: [sparkTransform], errors: [] }; });
    await runPreview({ "src/transform-05/datasets/new_file.py": "# new" });
    const paths = (discoveredFiles as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toContain("src/transform-05/datasets/new_file.py");
  });
});

describe("runTransformPreview — error paths", () => {
  it("returns ok:false when the PySpark runtime is not configured (preflight)", async () => {
    mockedPreflight.mockImplementation(() => ({ ok: false, python: "python3", javaHome: null, error: "PySpark runtime not configured" }));
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/PySpark runtime not configured/);
    expect(r.engine).toBeNull();
    expect((executeTransform as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it("returns ok:false when no .py files are found", async () => {
    mockedReadRepo.mockImplementation(async () => ({ files: [], kind: "ok" }));
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no \.py files/);
  });

  it("returns ok:false when the entryPoint is not discovered (carries discovery errors)", async () => {
    mockedDiscover.mockImplementation(() => ({ transforms: [], errors: [{ path: "x.py", message: "syntax error" }] }));
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/entry point 'spark_transform' not discovered/);
    expect(r.error).toMatch(/syntax error/);
  });

  it("returns ok:false when a real input dataset cannot be resolved (names the rid)", async () => {
    mockedResolve.mockImplementation(async () => null);
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toContain(INPUT_RID);
  });

  it("returns ok:false with stderr/traceback when executeTransform fails (no output)", async () => {
    mockedExecute.mockImplementation(async () => ({
      ok: false, outputPath: null, rowCount: 0, columns: [], writeMode: "replace",
      stdout: "", stderr: "boom", error: "kaboom", traceback: "tb", timedOut: false, durationMs: 3,
    } as ExecuteResult));
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("kaboom");
    expect(r.traceback).toBe("tb");
    expect(r.stderr).toBe("boom");
    expect(r.output).toBeNull();
    // inputs were still resolved + returned (so the UI can show them).
    expect(r.inputs).toHaveLength(1);
  });

  it("reports a timeout when executeTransform times out", async () => {
    mockedExecute.mockImplementation(async () => ({
      ok: false, outputPath: null, rowCount: 0, columns: [], writeMode: "replace",
      stdout: "", stderr: "", error: null, traceback: null, timedOut: true, durationMs: 100_000,
    } as ExecuteResult));
    const r = await runPreview();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});

const PREVIEW_HARNESS_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/services/codeRepository/transforms/previewHarness.ts"),
  "utf8",
);

describe("sanitizeFileOverrides — path-traversal guard (HIGH-severity regression)", () => {
  // fileOverrides keys are written into the executor's temp workdir via
  // path.join (local mode has no FS isolation). A "../driver.py" key would
  // escape the workdir + overwrite the driver -> RCE. These pin the guard.
  it("keeps a valid relative path", () => {
    expect(sanitizeFileOverrides({ "src/transform-05/datasets/spark_transform.py": "draft" }))
      .toEqual({ "src/transform-05/datasets/spark_transform.py": "draft" });
  });
  it("rejects keys containing a '..' segment (path traversal)", () => {
    expect(sanitizeFileOverrides({ "../driver.py": "evil" })).toBeUndefined();
    expect(sanitizeFileOverrides({ "src/../evil.py": "evil" })).toBeUndefined();
    expect(sanitizeFileOverrides({ "..\\evil.py": "evil" })).toBeUndefined();
  });
  it("rejects absolute paths", () => {
    expect(sanitizeFileOverrides({ "/etc/cron.d/evil.py": "evil" })).toBeUndefined();
  });
  it("drops non-string values", () => {
    expect(sanitizeFileOverrides({ "ok.py": "draft", "bad.py": 123, "obj.py": { x: 1 } }))
      .toEqual({ "ok.py": "draft" });
  });
  it("returns undefined for non-object / array / empty input", () => {
    expect(sanitizeFileOverrides(undefined)).toBeUndefined();
    expect(sanitizeFileOverrides(null)).toBeUndefined();
    expect(sanitizeFileOverrides([])).toBeUndefined();
    expect(sanitizeFileOverrides("string")).toBeUndefined();
    expect(sanitizeFileOverrides({})).toBeUndefined();
  });
  it("keeps valid + drops malicious in a mixed batch", () => {
    expect(sanitizeFileOverrides({
      "src/a.py": "draft-a",
      "../driver.py": "evil",
      "/abs/b.py": "evil",
      "src/b.py": "draft-b",
    })).toEqual({ "src/a.py": "draft-a", "src/b.py": "draft-b" });
  });
});

describe("previewHarness — no-commit guarantee", () => {
  // The defining preview semantic vs. dry-run/build is NO materializeOutput
  // (no committed dataset_transaction). previewHarness enforces this
  // structurally (it never imports materializeOutput). This source-level guard
  // fails if a future change adds a commit call — forcing an explicit decision.
  it("never references materializeOutput (preview is side-effect-free by construction)", () => {
    // Match a CALL (materializeOutput(...)) — not the word in doc comments
    // (which say "no materializeOutput / ..." without a paren). A regression
    // that adds a commit call would match this + fail the test.
    expect(PREVIEW_HARNESS_SRC).not.toMatch(/\bmaterializeOutput\s*\(/);
  });
});
