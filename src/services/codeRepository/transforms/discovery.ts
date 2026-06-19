// ===========================================================================
// Transform discovery — parses committed Python source for @transform /
// @transform_df / @transform_pandas / @incremental decorators and extracts the
// input->output dataset contract. This is the first link of the build loop
// (closes the FN_RE ".ts-only" discovery gap from the parity review).
//
// The parser is decorator-aware and balances parentheses across lines so it
// correctly reads multi-line decorators with nested Output(...)/Input(...).
// ===========================================================================

export type TransformKind = "transform" | "transform_df" | "transform_pandas";

export interface DiscoveredInput {
  /** The keyword-argument name the transform receives the input as. */
  readonly param: string;
  /** The input dataset RID. */
  readonly rid: string;
}

export interface DiscoveredTransform {
  /** Entry-point function name. */
  readonly name: string;
  /** Repo-relative path of the source file. */
  readonly sourcePath: string;
  readonly kind: TransformKind;
  /** The output dataset RID (from Output("...")). */
  readonly outputRid: string;
  readonly inputs: readonly DiscoveredInput[];
  /** True when an @incremental decorator is present. */
  readonly incremental: boolean;
}

export interface DiscoveryError {
  readonly path: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly transforms: readonly DiscoveredTransform[];
  readonly errors: readonly DiscoveryError[];
}

const TRANSFORM_KINDS = new Set<string>([
  "transform",
  "transform_df",
  "transform_pandas",
]);

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

/** Walk a module, returning every `def` together with its attached decorators. */
function scanModule(source: string): DefWithDecorators[] {
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

function extractInputs(args: string): DiscoveredInput[] {
  const inputs: DiscoveredInput[] = [];
  const re = /([A-Za-z_]\w*)\s*=\s*Input\(\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    inputs.push({ param: m[1], rid: m[2] });
  }
  return inputs;
}

function looksLikeRid(rid: string): boolean {
  // Reject unsubstituted template placeholders and obvious non-RIDs.
  if (rid.includes("{{") || rid.includes("}}")) return false;
  return /^ri\.[a-z0-9-]+\.[a-z0-9-]*\.[a-z0-9-]+\..+$/.test(rid);
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
      const kindDec = def.decorators.find((d) => TRANSFORM_KINDS.has(d.name));
      if (!kindDec) continue;

      const incremental = def.decorators.some((d) => d.name === "incremental");
      const outputRid = extractOutputRid(kindDec.args);
      const inputs = extractInputs(kindDec.args);

      if (!outputRid) {
        errors.push({
          path: file.path,
          message: `@${kindDec.name} on '${def.fn}' has no Output("...") dataset RID`,
        });
        continue;
      }
      if (!looksLikeRid(outputRid)) {
        errors.push({
          path: file.path,
          message: `@${kindDec.name} on '${def.fn}' has an invalid/placeholder Output RID '${outputRid}' (substitute the template parameter)`,
        });
        continue;
      }
      const badInput = inputs.find((inp) => !looksLikeRid(inp.rid));
      if (badInput) {
        errors.push({
          path: file.path,
          message: `Input '${badInput.param}' on '${def.fn}' has an invalid/placeholder RID '${badInput.rid}'`,
        });
        continue;
      }
      const prev = seenOutputs.get(outputRid);
      if (prev) {
        errors.push({
          path: file.path,
          message: `output dataset '${outputRid}' is produced by more than one transform (${prev} and ${file.path})`,
        });
        continue;
      }
      seenOutputs.set(outputRid, file.path);

      transforms.push({
        name: def.fn,
        sourcePath: file.path,
        kind: kindDec.name as TransformKind,
        outputRid,
        inputs,
        incremental,
      });
    }
  }

  return { transforms, errors };
}
