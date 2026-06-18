// B3 — Scaffold engine.
//
// Pure function: (manifest, params, repositoryRid, repoDisplayName) →
// { files: ScaffoldedFile[], commitSha: string, totalBytes: number }.
//
// Determinism: same inputs ALWAYS produce the same commitSha. The sha is
// sha256 of canonical(templateId, version, sortedParams, repositoryRid,
// sortedFile-list-with-content-shas). This guarantees scaffold idempotency
// without needing to defer to the actual git layer.

import { createHash } from "node:crypto";
import { canonicalJson } from "../audit/canonicalJson.js";
import { templatesError } from "./errors.js";
import type {
  TemplateFile,
  TemplateManifest,
  TemplateParameter,
} from "./manifest.js";

export interface ScaffoldedFile {
  readonly path: string;
  readonly content: string;        // utf8 source after substitution OR base64 binary
  readonly mode: "100644" | "100755";
  readonly isBinary: boolean;
  readonly bytes: number;
}

export interface ScaffoldResult {
  readonly commitSha: string;       // 40-hex deterministic
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: ReadonlyArray<ScaffoldedFile>;
}

export interface ScaffoldArgs {
  readonly manifest: TemplateManifest;
  readonly parameters: Readonly<Record<string, string>>;
  readonly repositoryRid: string;
  readonly repoDisplayName: string;
}

/**
 * Resolve effective parameters: caller-supplied values override defaults; missing
 * defaults that reference "<derived from repo name>" are auto-resolved from
 * repoDisplayName via lowercase + slugify.
 *
 * Throws Templates:ParameterValidationFailed on:
 *  - missing required parameter (no default + no caller value)
 *  - regex mismatch
 *  - unknown parameter (caller supplied value for a parameter not in the manifest)
 */
export function resolveParameters(
  parameters: ReadonlyArray<TemplateParameter>,
  caller: Readonly<Record<string, string>>,
  repoDisplayName: string,
): Record<string, string> {
  const declared = new Set(parameters.map((p) => p.name));
  for (const k of Object.keys(caller)) {
    if (!declared.has(k)) {
      throw templatesError("Templates:ParameterValidationFailed", {
        reason: "unknown-parameter",
        parameterName: k,
      });
    }
  }
  const out: Record<string, string> = {};
  for (const p of parameters) {
    let value = caller[p.name];
    if (value === undefined) {
      if (p.default === undefined) {
        throw templatesError("Templates:ParameterValidationFailed", {
          reason: "missing-required-parameter",
          parameterName: p.name,
        });
      }
      value = p.default === "<derived from repo name>" ? deriveFromRepoName(repoDisplayName, p.regex) : p.default;
    }
    const re = new RegExp(p.regex);
    if (!re.test(value)) {
      throw templatesError("Templates:ParameterValidationFailed", {
        reason: "regex-mismatch",
        parameterName: p.name,
        regex: p.regex,
      });
    }
    out[p.name] = value;
  }
  return out;
}

function deriveFromRepoName(name: string, regex: string): string {
  const lowered = name.toLowerCase();
  // Choose separator based on what the regex character class permits.
  // Many regexes are of the form ^[a-z][a-z0-9X]{...}$ where X is "-" or "_".
  const allowsHyphen = /-\]/.test(regex);
  const sep = allowsHyphen ? "-" : "_";
  let s = lowered.replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "");
  if (s.length === 0) s = "repo";
  if (s.length > 64) s = s.substring(0, 64);
  return s;
}

/**
 * Apply {{paramName}} substitutions to a single file's content (utf8 only;
 * binary files pass through). Also applies substitutions to file paths so
 * `src/{{packageName}}/__init__.py` resolves correctly.
 */
function substitute(text: string, params: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name) => {
    const v = params[name];
    if (v === undefined) {
      throw templatesError("Templates:ParameterValidationFailed", {
        reason: "unknown-substitution-token",
        token: name,
      });
    }
    return v;
  });
}

export function scaffold(args: ScaffoldArgs): ScaffoldResult {
  if (args.manifest.deprecated) {
    throw templatesError("Templates:VersionDeprecated", {
      templateId: args.manifest.templateId,
      version: args.manifest.version,
    });
  }
  const params = resolveParameters(
    args.manifest.parameters,
    args.parameters,
    args.repoDisplayName,
  );
  const files: ScaffoldedFile[] = args.manifest.files.map((tf: TemplateFile) => {
    const path = substitute(tf.path, params);
    const content = tf.isBinary ? tf.content : substitute(tf.content, params);
    const bytes = tf.isBinary
      ? Buffer.from(content, "base64").length
      : Buffer.byteLength(content, "utf8");
    return { path, content, mode: tf.mode, isBinary: tf.isBinary, bytes };
  });
  // Sort files for determinism, then compute commitSha.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = sorted.reduce((acc, f) => acc + f.bytes, 0);
  const commitInput = canonicalJson({
    templateId: args.manifest.templateId,
    version: args.manifest.version,
    repositoryRid: args.repositoryRid,
    parameters: params,
    files: sorted.map((f) => ({
      path: f.path,
      mode: f.mode,
      isBinary: f.isBinary,
      contentSha: createHash("sha256").update(f.content).digest("hex"),
    })),
  });
  const fullSha = createHash("sha256").update(commitInput).digest("hex");
  return {
    commitSha: fullSha.substring(0, 40),
    fileCount: sorted.length,
    totalBytes,
    files: sorted,
  };
}
