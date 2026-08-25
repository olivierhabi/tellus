// ===========================================================================
// Transform discovery — parses committed Python source for @transform /
// @transform_df / @transform_pandas / @lightweight / @incremental / @configure
// decorators and extracts the input->output dataset contract. This is the
// first link of the build loop.
//
// Parser: PRIMARY is a real Python `ast.parse` (via the transforms runtime
// python), which correctly handles multi-line decorators, aliased imports,
// f-string RIDs, and nested defs — the line-scanner missed the first three.
// The line-scanner is kept as a FALLBACK (if python3 is unavailable, e.g. a
// unit test without the runtime).
//
// @lightweight (transforms-python v3.0.0): a Palantir-Foundry-parity decorator
// that runs WITHOUT a SparkSession — single-process, pandas-only
// (Input.pandas() / Output.write_dataframe semantics). Discovered with the
// same I/O-extraction logic as @transform; the runtime reserved for this kind
// is 'lightweight' (vs 'spark' for the PySpark-backed decorators).
// ===========================================================================

import { spawnSync } from "child_process";
import { resolveTransformPython, resolveJavaHome } from "./runtimeConfig.js";

export type TransformKind = "transform" | "transform_df" | "transform_pandas" | "lightweight";

export interface DiscoveredOutput {
  /** The keyword-argument name the transform receives the output as. */
  readonly param: string;
  /** The output dataset reference (RID or catalog "/Project/Folder/Dataset" path). */
  readonly rid: string;
}

export interface DiscoveredInput {
  /** The keyword-argument name the transform receives the input as. */
  readonly param: string;
  /** The input dataset reference (RID or catalog "/Project/Folder/Dataset" path). */
  readonly rid: string;
}

export interface DiscoveredTransform {
  /** Entry-point function name. */
  readonly name: string;
  /** Repo-relative path of the source file. */
  readonly sourcePath: string;
  readonly kind: TransformKind;
  /** The first output dataset reference (single-Output backward-compat). */
  readonly outputRid: string;
  /** ALL outputs declared by the decorator (multi-Output Palantir Foundry form).
   * Length 1 for single-output @transform(output=...) and @transform.using(...). */
  readonly outputs: readonly DiscoveredOutput[];
  readonly inputs: readonly DiscoveredInput[];
  /** True when an @incremental decorator is present. */
  readonly incremental: boolean;
  /** Phase 5 — when @incremental(snapshot_inputs=["binding1", ...]) is
   * present, the parsed list of decorator binding names that the build
   * service must treat as 'current'-read snapshot inputs. NULL when no
   * @incremental decorator is present OR when @incremental is used without
   * snapshot_inputs. The driver's Input._is_snapshot_input flag is set per
   * binding — discovery just declares the names; the build service maps them
   * to the resolved Input._bind call. */
  readonly incrementalSnapshotInputs?: string[] | null;
  /** Phase 4 — the parsed `@incremental(semantic_version=N)` value (integer,
   *  default 1 when no kwarg). The buildService compares this to the
   *  persisted `transform_incremental_state.last_semantic_version`; on a
   *  mismatch the next build is forced into SNAPSHOT mode (all inputs read
   *  as `view='snapshot'`, `ctx.is_incremental=False`) and last_semantic_version
   *  is advanced post-commit. NULL when no @incremental decorator is present
   *  (the transform is non-incremental — the state machine leaves it
   *  untouched). */
  readonly incrementalSemanticVersion?: number | null;
  /** Phase 4 — `@incremental(require_incremental=True)` parses to true. */
  readonly incrementalRequireIncremental?: boolean | null;
  /** Phase 4 — `@incremental(allow_retention=True)` parses to true. */
  readonly incrementalAllowRetention?: boolean | null;
  /** Phase 4 — `@incremental(strict_append=True)` parses to true. */
  readonly incrementalStrictAppend?: boolean | null;
  /** Phase 4 — `@incremental(v2_semantics=True)` parses to true. */
  readonly incrementalV2Semantics?: boolean | null;
  /** Resource profile names from @configure(profile=[...]), or null. */
  readonly profile: string[] | null;
  /** True iff the decorator form was @transform.using(...) (Palantir v3.68.0+).
   * Carries no semantic effect in the discovery layer; the build service
   * surfaces it as the build's runtime='lightweight' flag when the kind is
   * 'transform' AND there is no stacked override forcing 'spark'. */
  readonly using: boolean;
  /** Per-transform runtime override ('lightweight' | 'spark'). When present,
   * takes precedence over runtimeFor(kind) — set by @transform.using / stacked
   * @lightweight@transform / @transform.spark.using. */
  readonly runtimeOverride?: TransformRuntime;
}

export interface DiscoveryError {
  readonly path: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly transforms: readonly DiscoveredTransform[];
  readonly errors: readonly DiscoveryError[];
}

/**
 * Recognized decorator leading-name segments. Includes the dotted
 * attribute-chain forms (transform.using etc.) per the Palantir Foundry
 * lightweight API (v3.68.0+) and spark.using (v3.95.0+). The base
 * TRANSFORM_KINDS values remain the four canonical TransformKind strings;
 * `classifyDecoratorName` maps an observed decorator name to that plus a
 * runtime override.
 */
const DECORATOR_KIND_NAMES = new Set<string>([
  "transform",
  "transform.using",
  "transform.lightweight",
  "transform.spark.using",
  "transform_df",
  "transform_pandas",
  "lightweight",
]);

const TRANSFORM_KINDS = new Set<string>([
  "transform",
  "transform_df",
  "transform_pandas",
  "lightweight",
]);

/** Classify an observed decorator name into {kind, runtimeOverride, using}. */
function classifyDecoratorName(name: string): {
  kind: TransformKind;
  runtimeOverride?: TransformRuntime;
  using: boolean;
} {
  switch (name) {
    case "transform.using":
      return { kind: "transform", runtimeOverride: "lightweight", using: true };
    case "transform.lightweight":
      return { kind: "transform", runtimeOverride: "lightweight", using: true };
    case "transform.spark.using":
      return { kind: "transform", runtimeOverride: "spark", using: true };
    case "lightweight":
      // Legacy stacked @lightweight (no parens) OR Tellus non-portable
      // extension @lightweight(output=, source=). Both → kind "lightweight";
      // the runtime is 'lightweight' for the kind; for the stacked form
      // (no bindings) the classifier is reached only when the bindings-on-top
      // decorator carries the I/O contract; see discoverTransforms.
      return { kind: "lightweight", runtimeOverride: "lightweight", using: false };
    case "transform_df":
      return { kind: "transform_df", using: false };
    case "transform_pandas":
      return { kind: "transform_pandas", using: false };
    case "transform":
    default:
      return { kind: "transform", using: false };
  }
}

/** A binding-carrying decorator has at least one Output(...) or Input(...)
 * literal in its args. The stacked `@lightweight` (no parens) form has none
 * and only flips the runtime; the classifier should pick the binding-carrying
 * decorator as the kind-coded decorator. */
function hasBindings(args: string): boolean {
  return /Output\s*\(\s*["'A-Za-z_]/.test(args) || /Input\s*\(\s*["'A-Za-z_]/.test(args);
}

/**
 * Execution-model tag recorded on transform_build.runtime (migration 120).
 *
 *   'lightweight' — @lightweight decorator only; runs subprocess, no Spark JVM,
 *                   no PySpark import required (Track 1 Runtime).
 *   'spark'       — @transform / @transform_df / @transform_pandas (the existing
 *                   PySpark-backed shim in runtime/pythonRuntime.ts: _get_spark).
 *
 * A repo mixing kinds records 'spark' as the build's runtime — the Spark JVM
 * is the superset runtime (it can host lightweight decorators too, though the
 * @lightweight contract forbids Input.dataframe(); the spark label is the safe
 * superset so historical reasoning about pre-3.0.0 builds is unchanged).
 */
export type TransformRuntime = "lightweight" | "spark";

export function runtimeFor(kind: TransformKind): TransformRuntime {
  return kind === "lightweight" ? "lightweight" : "spark";
}

/** Effective runtime for a discovered transform, honoring explicit overrides
 * (`@transform.using` → lightweight, `@transform.spark.using` → spark, stacked
 * `@lightweight@transform(...)` legacy form → lightweight) before falling
 * back to the kind-implied default (`@transform_df` → spark, `@lightweight`
 * non-extension → lightweight). */
export function effectiveRuntime(t: DiscoveredTransform): TransformRuntime {
  return t.runtimeOverride ?? runtimeFor(t.kind);
}

/** Coalesce a batch's per-transform kinds into the build's single runtime tag.
 * 'spark' wins if ANY transform is Spark-backed (it can host lighter ones). */
export function runtimeForBatch(kinds: ReadonlyArray<TransformKind>): TransformRuntime {
  if (kinds.length === 0) return "lightweight";
  return kinds.some((k) => runtimeFor(k) === "spark") ? "spark" : "lightweight";
}

/** Like {@link runtimeForBatch} but consuming the full DiscoveredTransform so
 * the {@link effectiveRuntime} override is honored (transform.using ⇒
 * lightweight even when kind == "transform"). */
export function runtimeForDiscoveredBatch(
  transforms: ReadonlyArray<DiscoveredTransform>,
): TransformRuntime {
  if (transforms.length === 0) return "lightweight";
  return transforms.some((t) => effectiveRuntime(t) === "spark") ? "spark" : "lightweight";
}

// A python file is a transform source if it lives under transforms/ or src/
// (Foundry convention) and is not a test or the SDK shim.
const SOURCE_RE = /(^|\/)(transforms|src)\/.*\.py$/;

function isTransformSource(path: string): boolean {
  if (!SOURCE_RE.test(path)) return false;
  const base = path.split("/").pop() ?? "";
  if (base === "api.py") return false;
  // Leading underscore => private/disabled module (e.g. _incremental_example.py,
  // __init__.py); not discovered as a buildable transform.
  if (base.startsWith("_")) return false;
  if (base.includes(".test.") || base.startsWith("test_")) return false;
  return true;
}

interface RawDecorator {
  readonly name: string;
  readonly args: string;
}

function parenBalance(s: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "#") break; // comment to end of line
  }
  return depth;
}

function parseDecorator(text: string): RawDecorator {
  // text starts after the leading '@'
  const open = text.indexOf("(");
  if (open === -1) return { name: text.trim(), args: "" };
  const name = text.slice(0, open).trim();
  const last = text.lastIndexOf(")");
  const args = last > open ? text.slice(open + 1, last) : text.slice(open + 1);
  return { name, args };
}

interface DefWithDecorators {
  readonly fn: string;
  readonly decorators: readonly RawDecorator[];
  readonly line: number;
}

/** Python AST script: parse the module (read from stdin), return each top-level
 * FunctionDef + its decorator source segments (the text after `@`). ast.parse
 * handles multi-line decorators, f-strings, and aliased imports that the
 * line-scanner missed. */
const AST_PARSE_SCRIPT = `import ast, json, sys
src = sys.stdin.read()
out = []
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"error": str(e)})); sys.exit(0)
for node in tree.body:
    if not isinstance(node, ast.FunctionDef):
        continue
    decos = []
    for d in node.decorator_list:
        seg = ast.get_source_segment(src, d)
        if seg is not None:
            decos.append(seg)
    if decos:
        out.append({"fn": node.name, "line": node.lineno, "decorators": decos})
print(json.dumps(out))
`;

/** Walk a module, returning every `def` together with its attached decorators.
 * PRIMARY: real Python `ast.parse` (handles multi-line decorators, f-strings,
 * aliased imports). FALLBACK: the line-scanner (if python3 is unavailable). */
function scanModule(source: string): DefWithDecorators[] {
  try {
    const py = resolveTransformPython();
    const r = spawnSync(py, ["-c", AST_PARSE_SCRIPT], {
      input: source,
      encoding: "utf8",
      env: { ...process.env, JAVA_HOME: resolveJavaHome() ?? "" },
      timeout: 15_000,
    });
    if (r.status === 0 && r.stdout) {
      const parsed = JSON.parse(r.stdout.trim());
      if (Array.isArray(parsed)) {
        return parsed.map((d: { fn: string; line: number; decorators: string[] }) => ({
          fn: d.fn,
          line: d.line,
          decorators: d.decorators.map((t) => parseDecorator(t)),
        }));
      }
    }
  } catch {
    /* fall through to the line-scanner */
  }
  return scanModuleLineScan(source);
}

/** Fallback line-scanner (used if the AST parse is unavailable). Decorator-
 * aware, paren-balanced for multi-line decorators — but misses f-string RIDs,
 * aliased imports, and same-line def+decorator. */
function scanModuleLineScan(source: string): DefWithDecorators[] {
  const lines = source.split(/\r?\n/);
  const out: DefWithDecorators[] = [];
  let pending: RawDecorator[] = [];
  let buf: string | null = null;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (buf !== null) {
      buf += "\n" + line;
      depth += parenBalance(line);
      if (depth <= 0) {
        pending.push(parseDecorator(buf.trimStart().slice(1)));
        buf = null;
        depth = 0;
      }
      continue;
    }

    const stripped = line.trimStart();
    if (stripped.startsWith("@")) {
      const d = stripped.slice(1);
      const bal = parenBalance(stripped);
      if (bal > 0) {
        buf = stripped;
        depth = bal;
      } else {
        pending.push(parseDecorator(d));
      }
      continue;
    }

    const defMatch = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(stripped);
    if (defMatch) {
      if (pending.length > 0) {
        out.push({ fn: defMatch[1], decorators: pending, line: i + 1 });
      }
      pending = [];
      continue;
    }

    // Blank lines and comments may sit between decorators and the def.
    if (stripped === "" || stripped.startsWith("#")) continue;

    // Any other statement breaks the decorator chain.
    pending = [];
  }
  return out;
}

function extractOutputRid(args: string): string | null {
  const m = /Output\(\s*["']([^"']+)["']/.exec(args);
  return m ? m[1] : null;
}

/** Extract ALL Output(...) bindings by decorator kwarg name. Multi-output
 * transforms (the Palantir Foundry form `output=Output(...)`, `processed=Output(...)`,
 * `males=Output(...)`, etc.) return each binding pair. Single-output
 * `@transform(output=Output(...), source=Input(...))` returns 1 entry whose
 * param is the literal kwarg name (`output` here). */
function extractOutputs(args: string): DiscoveredOutput[] {
  const out: DiscoveredOutput[] = [];
  const re = /([A-Za-z_]\w*)\s*=\s*Output\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push({ param: m[1], rid: m[2] });
  }
  return out;
}

function extractInputs(args: string): DiscoveredInput[] {
  const inputs: DiscoveredInput[] = [];
  const re = /([A-Za-z_]\w*)\s*=\s*Input\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    inputs.push({ param: m[1], rid: m[2] });
  }
  return inputs;
}

/** Extract the snapshot_inputs=["a","b"] list from an @incremental(...)
 * decorator's args. Returns null when no snapshot_inputs kwarg is present.
 * Handles "..." and '...' quoted names per the spec: snapshot_inputs refers to
 * decorator binding NAMES (not paths or RIDs). */
export function extractSnapshotInputs(args: string): string[] | null {
  const m = /snapshot_inputs\s*=\s*\[([^\]]*)\]/.exec(args);
  if (!m) return null;
  const list = m[1];
  const names: string[] = [];
  const re = /["']([^"']+)["']/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(list)) !== null) {
    names.push(mm[1]);
  }
  return names.length > 0 ? names : null;
}

/** Extract the integer N from `@incremental(semantic_version=N)`. Returns NULL
 * (use the spec default of 1) when no kwarg is present OR the value is not a
 *  parseable positive integer. The buildService state machine compares this
 *  discovered value to the persisted `last_semantic_version`; a mismatch forces
 *  a snapshot recompute on the next build, then advances the persisted value
 *  post-commit. */
export function extractSemanticVersion(args: string): number | null {
  const m = /semantic_version\s*=\s*([0-9]+)/.exec(args);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract a boolean kwarg from `@incremental(name=True|False)`. Returns null
 *  when no kwarg is present (defaults are applied by the buildService upsert
 *  row). Recognizes `True`/`False` (Python literal) and `true`/`false` (JSON). */
export function extractIncrementalBool(args: string, name: string): boolean | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(True|False|true|false)\\b`);
  const m = re.exec(args);
  if (!m) return null;
  const v = m[1];
  return v === "True" || v === "true";
}

/** Extract the profile=[...] list from a @configure decorator's args. Returns
 * null when no profile kwarg is present. Handles "..." and '...' quoted names. */
export function extractProfile(args: string): string[] | null {
  const m = /profile\s*=\s*\[([^\]]*)\]/.exec(args);
  if (!m) return null;
  const list = m[1];
  const names: string[] = [];
  const re = /["']([^"']+)["']/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(list)) !== null) {
    names.push(mm[1]);
  }
  return names.length > 0 ? names : null;
}

function looksLikeRid(rid: string): boolean {
  // Reject unsubstituted template placeholders and obvious non-RIDs.
  if (rid.includes("{{") || rid.includes("}}")) return false;
  return /^ri\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9-]+\..+$/.test(rid);
}

/** References can be either Palantir Foundry dataset RIDs
 * (`ri.foundry.main.dataset.<uuid>`) or catalog paths starting with `/`
 * (`/Project/Folder/Dataset`). The build service resolves catalog paths to
 * RIDs before constructing the job-spec (Phase 3 — catalogPathResolver). */
function looksLikeDatasetReference(ref: string): boolean {
  if (ref.includes("{{") || ref.includes("}}")) return false;
  if (ref.startsWith("/")) return true;
  return looksLikeRid(ref);
}

/**
 * Discover all transforms across a set of committed files.
 */
export function discoverTransforms(
  files: ReadonlyArray<{ path: string; content: string }>,
): DiscoveryResult {
  const transforms: DiscoveredTransform[] = [];
  const errors: DiscoveryError[] = [];
  const seenOutputs = new Map<string, string>(); // outputRid -> sourcePath

  for (const file of files) {
    if (!isTransformSource(file.path)) continue;

    let defs: DefWithDecorators[];
    try {
      defs = scanModule(file.content);
    } catch (e) {
      errors.push({ path: file.path, message: `parse failed: ${String(e)}` });
      continue;
    }

    for (const def of defs) {
      // The binding-carrying decorator is the kind-coded one. For the legacy
      // stacked form (@lightweight (no parens) above @transform(...)), the
      // `lightweight` decorator has empty args and only flips the runtime; the
      // binding-carrying decorator is `transform`. Pick the one with
      // Output/Input bindings present (and a recognized kind name).
      const kindDec = def.decorators.find(
        (d) => DECORATOR_KIND_NAMES.has(d.name) && hasBindings(d.args),
      );
      if (!kindDec) continue;

      const cls = classifyDecoratorName(kindDec.name);
      const incrementalDec = def.decorators.find((d) => d.name === "incremental");
      const incremental = !!incrementalDec;
      const incrementalSnapshotInputs = incrementalDec
        ? extractSnapshotInputs(incrementalDec.args)
        : null;
      const incrementalSemanticVersion = incrementalDec
        ? extractSemanticVersion(incrementalDec.args)
        : null;
      const incrementalRequireIncremental = incrementalDec
        ? extractIncrementalBool(incrementalDec.args, "require_incremental")
        : null;
      const incrementalAllowRetention = incrementalDec
        ? extractIncrementalBool(incrementalDec.args, "allow_retention")
        : null;
      const incrementalStrictAppend = incrementalDec
        ? extractIncrementalBool(incrementalDec.args, "strict_append")
        : null;
      const incrementalV2Semantics = incrementalDec
        ? extractIncrementalBool(incrementalDec.args, "v2_semantics")
        : null;
      const configureDec = def.decorators.find((d) => d.name === "configure");
      const profile = configureDec ? extractProfile(configureDec.args) : null;

      const outputs = extractOutputs(kindDec.args);
      const inputs = extractInputs(kindDec.args);
      if (outputs.length === 0) {
        errors.push({
          path: file.path,
          message: `@${kindDec.name} on '${def.fn}' has no Output(...) binding`,
        });
        continue;
      }
      const outputRid = outputs[0].rid;
      const badOutput = outputs.find((o) => !looksLikeDatasetReference(o.rid));
      if (badOutput) {
        errors.push({
          path: file.path,
          message: `@${kindDec.name} on '${def.fn}' has an invalid/placeholder Output reference '${badOutput.rid}' on binding '${badOutput.param}' (RID or /catalog/path expected)`,
        });
        continue;
      }
      const badInput = inputs.find((inp) => !looksLikeDatasetReference(inp.rid));
      if (badInput) {
        errors.push({
          path: file.path,
          message: `Input '${badInput.param}' on '${def.fn}' has an invalid/placeholder dataset reference '${badInput.rid}'`,
        });
        continue;
      }

      // Cycle detection (within a single transform): input rid resolves to
      // the same dataset as any output rid → reject per Palantir contract.
      // Note: this regex-level check uses the raw reference string; the build
      // service post-resolution check (Phase 3) catches cycles that emerge
      // after path→RID canonicalization.
      const outputRefs = new Set(outputs.map((o) => o.rid));
      const cycleInput = inputs.find((inp) => outputRefs.has(inp.rid));
      if (cycleInput) {
        errors.push({
          path: file.path,
          message: `@${kindDec.name} on '${def.fn}' has input '${cycleInput.param}' referencing the same dataset as output '${cycleInput.rid}' — cyclic input/output dependency is forbidden`,
        });
        continue;
      }

      // Phase 5 — validate snapshot_inputs binding names refer to actual
      // decorator binding names declared by the kindDec (per spec §5 "Names
      // in snapshot_inputs refer to decorator binding names, not paths or
      // RIDs" + "validate that every configured snapshot-input name exists
      // in the decorator bindings"). Reference-table joins + historical-
      // snapshot accumulation depend on per-input read-mode overrides keyed
      // by the binding name; an unknown name is a no-op override that would
      // silently fail to apply — surface loudly at discovery so the user
      // sees the error before the build is scheduled.
      if (incrementalSnapshotInputs && incrementalSnapshotInputs.length > 0) {
        const bindingNames = new Set<string>([
          ...inputs.map((i) => i.param),
          ...outputs.map((o) => o.param),
        ]);
        const unknown = incrementalSnapshotInputs.filter((n) => !bindingNames.has(n));
        if (unknown.length > 0) {
          errors.push({
            path: file.path,
            message: `@incremental(snapshot_inputs=[${incrementalSnapshotInputs.map((n) => `'${n}'`).join(", ")}]) on '${def.fn}' lists unknown binding name(s): ${unknown.map((n) => `'${n}'`).join(", ")}. Valid binding names are inputs + outputs of @${kindDec.name} (${Array.from(bindingNames).map((b) => `'${b}'`).join(", ")}).`,
          });
          continue;
        }
      }

      // Duplicate-output check across transforms (one dataset produced by
      // ≥1 transform). Backward-compat: uses the FIRST outputRid (single-output
      // case); multi-output transforms still register all outputs via a
      // post-loop pass below.
      const prev = seenOutputs.get(outputRid);
      if (prev) {
        errors.push({
          path: file.path,
          message: `output dataset '${outputRid}' is produced by more than one transform (${prev} and ${file.path})`,
        });
        continue;
      }
      for (const o of outputs) {
        if (o.rid !== outputRid) seenOutputs.set(o.rid, file.path);
      }
      seenOutputs.set(outputRid, file.path);

      // Stacked @lightweight (no parens) above @transform(...) (the Palantir
      // legacy form): the binding-carrying `kindDec` is 'transform' (default
      // runtime 'spark'); the stacked lightweight flips it to 'lightweight'.
      // Only flips when the underlying transform's runtime wasn't explicitly
      // set to spark by a dotted form (transform.spark.using); the runtime
      // override precedence: explicit dotted form > stacked @lightweight >
      // default (runtimeFor(kind)).
      let runtimeOverride = cls.runtimeOverride;
      let using = cls.using;
      if (kindDec.name === "transform") {
        const stackedLightweight = def.decorators.some(
          (d) => d.name === "lightweight" && !hasBindings(d.args),
        );
        if (stackedLightweight) {
          runtimeOverride = "lightweight";
          // Stacked form is NOT the .using Palantir-portable form; keep using=false.
        }
      }

      transforms.push({
        name: def.fn,
        sourcePath: file.path,
        kind: cls.kind,
        outputRid,
        outputs,
        inputs,
        incremental,
        incrementalSnapshotInputs,
        incrementalSemanticVersion,
        incrementalRequireIncremental,
        incrementalAllowRetention,
        incrementalStrictAppend,
        incrementalV2Semantics,
        profile,
        using,
        runtimeOverride,
      });
    }
  }

  return { transforms, errors };
}
