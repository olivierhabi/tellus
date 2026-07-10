// ===========================================================================
// testHarness.ts — local dry-run harness for @transform functions.
//
// Gap (testing/publishing): run a transform against FIXTURE (mock) inputs with
// NO side effects — no resolveDatasetByRid (real data), no materializeOutput
// (no committed dataset_transaction). Reuses the executor's workdir + driver
// (so the transform runs in the real python3 sandbox) but binds each Input to
// a fixture CSV written from `fixtures[param]` rows, and returns the output
// (rowCount/columns) WITHOUT materializing it. The output CSV lives in the
// executor's temp workdir, which the executor removes.
// ===========================================================================
import fs from "fs";
import os from "os";
import path from "path";
import type { StemmaAdapter } from "../adapters/types.js";
import { discoverTransforms } from "./discovery.js";
import { executeTransform, type ExecuteResult } from "./executor.js";
import { preflightTransformRuntime } from "./runtimeConfig.js";

export interface DryRunArgs {
  readonly stemma: StemmaAdapter;
  readonly repositoryRid: string;
  readonly branch: string;
  readonly entryPoint: string;
  /** Optional repo-relative path hint (the harness discovers by entryPoint). */
  readonly sourcePath?: string;
  /** Fixture rows per input param name. Each row is a dict (column -> value). */
  readonly fixtures: Record<string, Array<Record<string, unknown>>>;
}

export interface DryRunResult {
  readonly ok: boolean;
  readonly rowCount: number;
  readonly columns: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  readonly traceback: string | null;
}

function writeFixtureCsv(rows: Array<Record<string, unknown>>): string {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tellus-fixture-"));
  const fixturePath = path.join(fixtureDir, "fixture.csv");
  if (rows.length === 0) {
    fs.writeFileSync(fixturePath, "");
    return fixturePath;
  }
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  fs.writeFileSync(fixturePath, lines.join("\n"));
  return fixturePath;
}

export async function readRepoPyFiles(
  stemma: StemmaAdapter,
  repositoryRid: string,
  branch: string,
): Promise<{ files: Array<{ path: string; content: string }>; kind: string }> {
  const tree = await stemma.listTree({ repositoryRid, branch, path: "", depth: 5 });
  if (tree.kind !== "ok") {
    throw new Error(tree.kind === "branch-not-found" ? `branch not found: ${branch}` : `listTree failed: ${tree.kind}`);
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of tree.entries) {
    if (entry.type !== "blob" || !entry.path.endsWith(".py")) continue;
    if (!/(^|\/)(transforms|src)\//.test(entry.path)) continue;
    const blob = await stemma.readBlob({ repositoryRid, branch, path: entry.path });
    if (blob.kind !== "ok") continue;
    files.push({ path: entry.path, content: new TextDecoder("utf-8").decode(blob.content) });
  }
  return { files, kind: "ok" };
}

export async function runTransformDryRun(args: DryRunArgs): Promise<DryRunResult> {
  const rt = preflightTransformRuntime();
  if (!rt.ok) {
    return { ok: false, rowCount: 0, columns: [], stdout: "", stderr: "", error: rt.error ?? "runtime not configured", traceback: null };
  }

  const { files } = await readRepoPyFiles(args.stemma, args.repositoryRid, args.branch);
  if (files.length === 0) {
    return { ok: false, rowCount: 0, columns: [], stdout: "", stderr: "", error: "no .py files found under transforms/ or src/", traceback: null };
  }

  const discovery = discoverTransforms(files);
  const t = discovery.transforms.find((x) => x.name === args.entryPoint);
  if (!t) {
    return {
      ok: false, rowCount: 0, columns: [], stdout: "", stderr: "",
      error: `entry point '${args.entryPoint}' not discovered (discovery errors: ${discovery.errors.map((e) => e.message).join("; ") || "none"})`,
      traceback: null,
    };
  }

  // Bind each Input to a fixture CSV (NO resolveDatasetByRid — no real data).
  const fixturePaths: string[] = [];
  let exec: ExecuteResult | null = null;
  try {
    const inputs = t.inputs.map((inp) => {
      const rows = args.fixtures[inp.param];
      if (!rows) {
        throw new Error(`no fixture provided for input param '${inp.param}'`);
      }
      const p = writeFixtureCsv(rows);
      fixturePaths.push(p);
      return { param: inp.param, rid: inp.rid, path: p, format: "csv", previousPath: null };
    });

    // Run the transform in the real python3 sandbox. isIncremental=false (a
    // dry-run has no prior output state). The output CSV is written to a
    // SEPARATE temp dir (tellus-transform-out-*) from the workdir — the
    // executor removes the workdir but NOT the output dir on success, so the
    // caller must clean it up here (otherwise the dry-run leaks dirs).
    exec = await executeTransform({ transform: t, files, inputs, isIncremental: false });
    return {
      ok: exec.ok,
      rowCount: exec.rowCount,
      columns: exec.columns,
      stdout: exec.stdout,
      stderr: exec.stderr,
      error: exec.error,
      traceback: exec.traceback,
    };
  } finally {
    for (const p of fixturePaths) {
      try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    if (exec?.outputPath) {
      try { fs.rmSync(path.dirname(exec.outputPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
