// ===========================================================================
// previewHarness.ts — Foundry-faithful transform preview.
//
// Runs ONE @transform against its REAL committed input datasets (resolved by
// RID, read-only — no fixture rows, no mutation), in the real PySpark sandbox,
// and returns SAMPLE output rows + per-input sample rows + logs — with NO side
// effects (no materializeOutput / committed dataset_transaction). This is the
// backend of the code-repository toolbar "Preview" button:
//   click Preview -> POST /code-repositories/:rid/transforms/preview -> here
//   -> the output rows render in the existing TransformPreview UI.
//
// Contrast with testHarness.ts (dry-run, POST .../transforms/test): the dry-run
// binds Inputs to caller-supplied FIXTURE CSVs and DROPS the output rows
// (returns only rowCount/columns). The preview binds Inputs to REAL data
// (resolveDatasetByRid) and READS BACK the output CSV (sample N rows) —
// Foundry's Preview semantics: run against real inputs, show sample output,
// no commit.
//
// Optional fileOverrides: { path -> content } merged over the committed tree,
// so the user can preview UNSAVED editor drafts (edit -> Preview, no commit
// required). Without overrides, the committed branch state is previewed.
// ===========================================================================
import fs from "fs";
import path from "path";
import type { StemmaAdapter } from "../adapters/types.js";
import { discoverTransforms } from "./discovery.js";
import { executeTransform, type ExecuteResult, type ExecutorInputBinding } from "./executor.js";
import { preflightTransformRuntime } from "./runtimeConfig.js";
import { lookupDatasetName, resolveTransformInput } from "./datasetStore.js";
import { type TransformPrincipal } from "./authz.js";
import { readCSV } from "../../indexing/csvReader.js";
import { readRepoPyFiles } from "./testHarness.js";

export interface PreviewArgs {
  readonly stemma: StemmaAdapter;
  readonly repositoryRid: string;
  readonly branch: string;
  readonly entryPoint: string;
  /** Repo-relative path of the file being previewed. Optional but STRONGLY
   * recommended: when the entry-point function name is ambiguous across files
   * (e.g. two `def compute` in two source files), the lookup prefers the
   * sourcePath-matched transform; without it, the FIRST discovered transform
   * with the matching name wins — which silently runs the WRONG function's
   * output and surfaces it in the Preview UI. Pass the active file path. */
  readonly sourcePath?: string;
  /** Repo-relative path -> draft content, merged over the committed tree so the
   * user can preview unsaved editor changes (no commit required). */
  readonly fileOverrides?: Readonly<Record<string, string>>;
  /** P0 authz: the triggering user — read-checked on each foundry-catalog input
   * before it's staged. (Preview never writes an output, so there's no write
   * check here — only input read-access.) */
  readonly principal: TransformPrincipal;
  /** AbortSignal — aborted by the route handler on client disconnect (FE Stop /
   * connection close) so the in-flight preview child is killed server-side
   * instead of running to the 100s exec timeout. Threaded to executeTransform →
   * runChild/runChildContainer. */
  readonly signal?: AbortSignal;
}

export interface PreviewSample {
  readonly rowCount: number;
  readonly columns: string[];
  readonly rows: Array<Record<string, string>>;
}

export interface PreviewInput extends PreviewSample {
  readonly param: string;
  readonly rid: string;
  /** The dataset's display name (`dataset.name` or `foundry_datasets.name`).
   * Null when absent. */
  readonly name: string | null;
}

export interface PreviewResult {
  readonly ok: boolean;
  readonly entryPoint: string;
  readonly engine: "pandas" | "spark" | null;
  readonly inputs: PreviewInput[];
  readonly output: ({ readonly rid: string; readonly name: string | null } & PreviewSample) | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
  readonly traceback: string | null;
  readonly durationMs: number;
}

const PREVIEW_SAMPLE_ROWS = 100;
// < the raised CODE_REPOS_REQUEST_TIMEOUT_MS (120s) so the transform SIGKILLs
// before the HTTP layer returns a 504.
const PREVIEW_EXEC_TIMEOUT_MS = 100_000;

function fail(
  args: PreviewArgs,
  error: string,
  opts: {
    engine?: "pandas" | "spark" | null;
    inputs?: PreviewInput[];
    stdout?: string;
    stderr?: string;
    durationMs?: number;
  } = {},
): PreviewResult {
  return {
    ok: false,
    entryPoint: args.entryPoint,
    engine: opts.engine ?? null,
    inputs: opts.inputs ?? [],
    output: null,
    stdout: opts.stdout ?? "",
    stderr: opts.stderr ?? "",
    error,
    traceback: null,
    durationMs: opts.durationMs ?? 0,
  };
}

/** Merge fileOverrides over the committed files: replace existing paths, add
 * new ones (a draft for a not-yet-committed file). */
function mergeOverrides(
  files: Array<{ path: string; content: string }>,
  overrides?: Readonly<Record<string, string>>,
): Array<{ path: string; content: string }> {
  if (!overrides || Object.keys(overrides).length === 0) return files;
  const out = files.map((f) => {
    const ov = overrides[f.path];
    return ov != null ? { path: f.path, content: ov } : f;
  });
  for (const [p, content] of Object.entries(overrides)) {
    if (!files.some((f) => f.path === p)) out.push({ path: p, content });
  }
  return out;
}

/** Read up to PREVIEW_SAMPLE_ROWS rows from a CSV (defensive: never throws). */
async function readSample(filePath: string): Promise<PreviewSample> {
  try {
    const r = await readCSV(filePath, { maxRows: PREVIEW_SAMPLE_ROWS });
    if (r.success) {
      return { rowCount: r.rowCount, columns: r.columns, rows: r.rows };
    }
    return { rowCount: 0, columns: [], rows: [] };
  } catch {
    return { rowCount: 0, columns: [], rows: [] };
  }
}

/** Sanitize + validate fileOverrides from the request body: keep only
 * string-valued entries whose path is RELATIVE and contains no ".." segment.
 * Path-traversal guard: override keys are written into the executor's temp
 * workdir via path.join (local mode has no FS isolation), so a key like
 * "../driver.py" would escape the workdir + overwrite the driver -> RCE as
 * the backend user. The executor ALSO contains at the write site
 * (path.resolve + startsWith repoRoot) as defense-in-depth. Returns undefined
 * when nothing survives (so the preview reads the committed branch state). */
export function sanitizeFileOverrides(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("/") || k.split("/").includes("..") || k.split("\\").includes("..")) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function runTransformPreview(args: PreviewArgs): Promise<PreviewResult> {
  const startedAt = Date.now();

  const rt = preflightTransformRuntime();
  if (!rt.ok) {
    return fail(args, rt.error ?? "PySpark runtime not configured");
  }

  // Read the committed tree, then merge any unsaved drafts (fileOverrides).
  let merged: Array<{ path: string; content: string }>;
  try {
    const { files } = await readRepoPyFiles(args.stemma, args.repositoryRid, args.branch);
    if (files.length === 0) {
      return fail(args, "no .py files found under transforms/ or src/");
    }
    merged = mergeOverrides(files, args.fileOverrides);
  } catch (e) {
    return fail(args, `failed to read repo files: ${String(e)}`);
  }

  const discovery = discoverTransforms(merged);
  // Source-path-aware lookup: prefer the transform whose sourcePath matches when
  // supplied (the active file in the editor). Fall back to the first name match
  // only when sourcePath is absent (preserves legacy behavior for callers that
  // pass only the entry point name). Without this disambiguation, two transforms
  // sharing an entry-point name (e.g. two `def compute` in two source files) are
  // indistinguishable + the FIRST discovered one silently wins — surfacing the
  // wrong function's output in the Preview UI.
  const t = args.sourcePath
    ? discovery.transforms.find((x) => x.name === args.entryPoint && x.sourcePath === args.sourcePath)
      ?? discovery.transforms.find((x) => x.name === args.entryPoint)
    : discovery.transforms.find((x) => x.name === args.entryPoint);
  if (!t) {
    return fail(
      args,
      `entry point '${args.entryPoint}' not discovered (discovery errors: ${discovery.errors.map((e) => e.message).join("; ") || "none"})`,
    );
  }
  // @transform_pandas uses Input.pandas() (no SparkSession) -> "pandas";
  // @transform / @transform_df use Input.dataframe() (real pyspark) -> "spark".
  const engine: "pandas" | "spark" = t.kind === "transform_pandas" ? "pandas" : "spark";

  // Bind each Input to its REAL data (read-only — no fixtures, no mutation).
  // resolveTransformInput bridges BOTH dataset stores: the transform/upload
  // `dataset` table (slug-<8hex> rids, on-disk files) AND the Foundry catalog
  // `foundry_datasets` (UUID rids, object storage — staged to a temp CSV so the
  // python driver can read it). Foundry-bridge inputs carry a stagedPath the
  // finally below cleans up; dataset-table inputs are permanent (no cleanup).
  const inputSamples: PreviewInput[] = [];
  const stagedPaths: string[] = [];
  let bindings: ExecutorInputBinding[] = [];
  let exec: ExecuteResult | null = null;
  try {
    try {
      bindings = [];
      for (const inp of t.inputs) {
        const resolved = await resolveTransformInput(inp.rid, args.branch, args.principal);
        if (!resolved) {
          return fail(args, `input dataset not found: ${inp.rid} (param '${inp.param}')`, { inputs: inputSamples, engine });
        }
        if (resolved.stagedPath) stagedPaths.push(resolved.stagedPath);
        inputSamples.push({ param: inp.param, rid: inp.rid, name: resolved.name ?? null, ...(await readSample(resolved.filePath)) });
        bindings.push({ param: inp.param, rid: inp.rid, path: resolved.filePath, format: resolved.fileFormat ?? "csv", previousPath: null });
      }
    } catch (e) {
      return fail(args, `input resolution failed: ${String(e)}`, { inputs: inputSamples, engine });
    }

    // Run the transform in the real PySpark sandbox. isIncremental=false (a
    // preview has no prior output state). The output CSV is written to a temp
    // dir (exec.outputPath); we read it back for sample rows, then clean it up.
    // NO materializeOutput — no committed dataset_transaction (preview is
    // side-effect-free).
    exec = await executeTransform({
      transform: t,
      files: merged,
      inputs: bindings,
      isIncremental: false,
      timeoutMs: PREVIEW_EXEC_TIMEOUT_MS,
      signal: args.signal,
    });
    if (!exec.ok || !exec.outputPath) {
      return {
        ok: false,
        entryPoint: args.entryPoint,
        engine,
        inputs: inputSamples,
        output: null,
        stdout: exec.stdout,
        stderr: exec.stderr,
        error: exec.error ?? (exec.timedOut ? `transform timed out after ${PREVIEW_EXEC_TIMEOUT_MS}ms` : "transform failed"),
        traceback: exec.traceback,
        durationMs: Date.now() - startedAt,
      };
    }
    const outputSample = await readSample(exec.outputPath);
    return {
      ok: true,
      entryPoint: args.entryPoint,
      engine,
      inputs: inputSamples,
      output: { rid: t.outputRid, name: await lookupDatasetName(t.outputRid), ...outputSample },
      stdout: exec.stdout,
      stderr: exec.stderr,
      error: null,
      traceback: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return fail(args, `execution failed: ${String(e)}`, {
      engine,
      inputs: inputSamples,
      stdout: exec?.stdout ?? "",
      stderr: exec?.stderr ?? "",
      durationMs: Date.now() - startedAt,
    });
  } finally {
    // Clean BOTH temp artifacts: the executor's output dir (read back above)
    // + any staged foundry-bridge input files. A partial input resolution that
    // stages input[0] then fails on input[1] returns from the inner try above
    // — this finally still runs + cleans the staged input[0] (no leak).
    if (exec?.outputPath) {
      try { fs.rmSync(path.dirname(exec.outputPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    for (const p of stagedPaths) {
      try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
