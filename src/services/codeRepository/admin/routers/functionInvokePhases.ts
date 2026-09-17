// ---------------------------------------------------------------------------
// Function-invoke phases — extracted from admin/routes.ts.
//
// The POST /:rid/functions/invoke handler is a long orchestration pipeline:
// body validation → source resolution → transpile → ontology snapshot →
// sandbox exec → edit collection → response shaping. The self-contained
// phases live here as pure-ish functions returning discriminated results;
// the router (./functionInvokeRouter.ts) keeps orchestration, sandbox
// execution, and response shaping.
//
// Each phase preserves the exact envelopes the monolith produced — the
// router maps `{ kind: "invalid"|"error", errorName, parameters }` results
// back through `sendError(res, codeReposError(...))` unchanged.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import { FUNCTION_IDENTITY_RE } from "../../../functions/discovery";
import { parseSemver, compareSemver } from "../../../functionsRegistry/semver";
import {
  FunctionArtifactError,
  resolveFunctionSource,
} from "../../../functionsRegistry/artifactStore";
import { getVersion, listVersions } from "../../../functionsRegistry/store";
import { loadOntologySnapshot } from "../../../functions/ontologyRuntime";
import type { OntologySnapshot } from "../../../functions/ontologyRuntime";
import { scanSourceForEscapePatterns } from "../../../functionRuntime";
import type { StemmaAdapter } from "../../adapters/types";
import { createTtlCache, transpileCacheKey } from "../invokeCache";
import type { CodeReposErrorName } from "../../errors";

// ---------------------------------------------------------------------------
// Shared invoke caches (moved from admin/routes.ts).
// ---------------------------------------------------------------------------

// Per-process caches for the function-invoke hot path. See invokeCache.ts for
// the rationale (burst-coalescing the invokes a Workshop Object Table fires).
// `transpileCache` is content-addressed (no TTL); `snapshotCache` is TTL-bound
// because `object_instances` is mutable — a few seconds of staleness is the
// right tradeoff for a Workshop Live-Preview read (point-in-time snapshot).
const transpileCache = createTtlCache<string, string>({ maxEntries: 64 });
const SNAPSHOT_TTL_MS = Number(process.env.FUNCTION_SNAPSHOT_TTL_MS ?? 5_000);
const snapshotCache = createTtlCache<string, OntologySnapshot>({
  maxEntries: 8,
  ttlMs: SNAPSHOT_TTL_MS,
});

// ---------------------------------------------------------------------------
// Phase 1 — body validation.
// ---------------------------------------------------------------------------

export interface ValidInvokeBody {
  readonly apiName: string;
  readonly args: unknown;
  readonly branch: string | null;
  readonly source: unknown;
  readonly inlineSource: string | null;
  readonly inlineSourcePath: string | null;
  /** Exact published version to run (Path B-pinned) — resolved
   *  server-side so callers never ship the source inline. */
  readonly semver: string | null;
  readonly applyEdits: unknown;
}

export type ParsedInvokeBody =
  | { kind: "ok"; body: ValidInvokeBody }
  | { kind: "invalid"; errorName: CodeReposErrorName; parameters: Record<string, unknown> };

/** Size cap: 256 KB. A single source file at that size already
 * exceeds the practical authoring limit (the largest scaffolded
 * function is ~2 KB); the cap exists to make a misbehaving client
 * observable rather than to constrain real authors. */
const INLINE_SOURCE_MAX_BYTES = 256 * 1024;

/**
 * Validate the invoke body — must precede file lookup so malformed
 * input returns a clean 4xx regardless of whether the function exists.
 */
export function parseInvokeBody(raw: unknown): ParsedInvokeBody {
  const body = (raw ?? {}) as {
    apiName?: unknown;
    args?: unknown;
    branch?: unknown;
    source?: unknown;
    inlineSource?: unknown;
    inlineSourcePath?: unknown;
    semver?: unknown;
    applyEdits?: unknown;
  };
  const apiName = typeof body.apiName === "string" ? body.apiName : "";
  // Identity can be a plain identifier ("calc") or a directory-qualified
  // path under src/functions/ ("orders/calc") — see functions/discovery.ts.
  if (!apiName || !FUNCTION_IDENTITY_RE.test(apiName) || apiName.length > 256) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidArgumentBody",
      parameters: {
        field: "apiName",
        reason: "required; must be a function identity (identifier or nested path under src/functions/)",
      },
    };
  }
  if (
    body.args !== undefined &&
    (body.args === null ||
      typeof body.args !== "object" ||
      Array.isArray(body.args))
  ) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidArgumentBody",
      parameters: {
        field: "args",
        reason: "must be a JSON object (or omitted)",
      },
    };
  }
  // Path A: optional inline source for real-time edit-and-rerun.
  // The IDE's Monaco draft buffer travels with the Run request and
  // shortcuts the stemma read entirely. The user-facing flow is
  // therefore edit → Run (no Commit needed) — which is the Foundry
  // Code Repositories convention for unpublished function previews.
  let inlineSource: string | null = null;
  if (body.inlineSource !== undefined && body.inlineSource !== null) {
    if (typeof body.inlineSource !== "string") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidArgumentBody",
        parameters: {
          field: "inlineSource",
          reason: "must be a string (UTF-8 source)",
        },
      };
    }
    const bytes = Buffer.byteLength(body.inlineSource, "utf8");
    if (bytes > INLINE_SOURCE_MAX_BYTES) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidArgumentBody",
        parameters: {
          field: "inlineSource",
          reason: `exceeds ${INLINE_SOURCE_MAX_BYTES} byte cap (got ${bytes})`,
        },
      };
    }
    if (body.inlineSource.length > 0) inlineSource = body.inlineSource;
  }
  // inlineSourcePath is informational — used only to choose the
  // transpile language. If absent, we infer from the discovered tree
  // entry (or default to TS when inlineSource is provided without a
  // path, since the working-tree IDE only edits TS today).
  let inlineSourcePath: string | null = null;
  if (body.inlineSourcePath !== undefined && body.inlineSourcePath !== null) {
    if (typeof body.inlineSourcePath !== "string" || body.inlineSourcePath.length > 1024) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidArgumentBody",
        parameters: {
          field: "inlineSourcePath",
          reason: "must be a string ≤ 1024 chars",
        },
      };
    }
    inlineSourcePath = body.inlineSourcePath;
  }

  // Pinned-release invoke: run an exact published version's artifact
  // without the caller shipping the source (kills the
  // list-versions-then-inlineSource round trips — the FE's Workshop
  // variable path downloaded 500KB+ of version manifests just to echo one
  // function's source back). Validated as a SemVer-shaped token; the
  // resolution below 404s unknown versions.
  let semver: string | null = null;
  if (body.semver !== undefined && body.semver !== null) {
    if (
      typeof body.semver !== "string" ||
      body.semver.length === 0 ||
      body.semver.length > 64 ||
      !/^[0-9A-Za-z.\-+]+$/.test(body.semver)
    ) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidArgumentBody",
        parameters: {
          field: "semver",
          reason: "must be a SemVer-shaped version token ≤ 64 chars",
        },
      };
    }
    semver = body.semver;
  }

  return {
    kind: "ok",
    body: {
      apiName,
      args: body.args,
      branch: typeof body.branch === "string" && body.branch.length > 0 ? body.branch : null,
      source: body.source,
      inlineSource,
      inlineSourcePath,
      semver,
      applyEdits: body.applyEdits,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — source resolution.
// ---------------------------------------------------------------------------

export interface InvokeSourceDeps {
  readonly pool: Pool;
  readonly stemma: StemmaAdapter;
}

export type ResolvedInvokeSource =
  | {
      kind: "ok";
      source: string;
      runtime: "NODE_20" | "PY_311";
      resolvedPath: string | null;
      branch: string;
    }
  | { kind: "error"; errorName: CodeReposErrorName; parameters: Record<string, unknown> };

/**
 * Resolve the repo + branch, then the function source. Three paths:
 *   1. Path A (real-time edit-and-rerun) — `inlineSource` skips Stemma.
 *   2. Path B (published) — highest-semver AVAILABLE version's artifact.
 *   3. Committed working tree — walk the tree, locate
 *      `<langProject>/src/functions/<apiName>.<ts|py>`, readBlob.
 */
export async function resolveInvokeSource(
  deps: InvokeSourceDeps,
  opts: {
    rid: string;
    bodyBranch: string | null;
    apiName: string;
    source: unknown;
    inlineSource: string | null;
    inlineSourcePath: string | null;
    semver?: string | null;
  },
): Promise<ResolvedInvokeSource> {
  const { rid, apiName } = opts;
  const { rows: repoRows } = await deps.pool.query<{
    rid: string;
    default_branch: string;
    state: string;
  }>(
    `SELECT rid, default_branch, state
       FROM code_repository WHERE rid = $1`,
    [rid],
  );
  if (repoRows.length === 0) {
    return { kind: "error", errorName: "CodeRepos:RepositoryNotFound", parameters: { rid } };
  }
  const repo = repoRows[0];
  const branch = opts.bodyBranch ?? repo.default_branch;

  let source: string;
  let runtime: "NODE_20" | "PY_311" = "NODE_20";
  let resolvedPath: string | null = null;

  if (opts.inlineSource !== null) {
    source = opts.inlineSource;
    if (opts.inlineSourcePath !== null && /\.py$/i.test(opts.inlineSourcePath)) {
      runtime = "PY_311";
    }
    resolvedPath = opts.inlineSourcePath; // informational only
  } else if (opts.source === "published") {
    // Path B (published) — run the artifact registered by Tag & Release.
    // Resolve the highest-semver AVAILABLE version on the branch and pull
    // the function's source through resolveFunctionSource: compact
    // bundle manifests read from the artifact store, historical inline
    // manifests (manifest.sources) keep working.
    //
    // Path B-pinned — `semver` selects ONE exact version server-side (one
    // indexed row lookup + one artifact resolution) so callers never need
    // to download the version list and echo the source back inline.
    if (opts.semver) {
      const pinned = await getVersion(deps.pool, rid, opts.semver, branch);
      if (!pinned || pinned.state !== "AVAILABLE") {
        return {
          kind: "error",
          errorName: "CodeRepos:FunctionNotFound",
          parameters: { apiName, source: "published", semver: opts.semver },
        };
      }
      let pinnedSource: string | null;
      try {
        pinnedSource = await resolveFunctionSource(
          { manifest_json: pinned.manifest as { sources?: Record<string, unknown> } | null, artifact_blob_id: pinned.artifactBlobId },
          apiName,
        );
      } catch (e) {
        if (e instanceof FunctionArtifactError) {
          return {
            kind: "error",
            errorName: "CodeRepos:PublishedArtifactMissing",
            parameters: {
              apiName,
              branch,
              semver: opts.semver,
              artifactErrorCode: e.code,
              reason:
                `Published artifact for "${apiName}" (${opts.semver}) ` +
                `is missing from object storage — try republishing the release.`,
            },
          };
        }
        throw e;
      }
      if (pinnedSource === null) {
        return {
          kind: "error",
          errorName: "CodeRepos:FunctionNotFound",
          parameters: { apiName, source: "published", semver: opts.semver },
        };
      }
      source = pinnedSource;
      runtime = "NODE_20";
      resolvedPath = `published:${opts.semver}`;
    } else {
    const versions = await listVersions(deps.pool, rid, { branch, includeYanked: false });
    let chosen: { semver: string; source: string } | null = null;
    // One version whose content-addressed bundle is gone (object store
    // rebuilt while Postgres metadata survived) must not poison invokes —
    // previously any ARTIFACT_NOT_FOUND escaped the loop and 500'd the
    // whole published-invoke path even though a healthy newer version
    // already resolved. Skip per-version, and only when NO version
    // delivers a source do we surface an actionable envelope.
    let artifactFailure: { semver: string; code: string } | null = null;
    for (const v of versions) {
      let src: string | null;
      try {
        src = await resolveFunctionSource(
          { manifest_json: v.manifest as { sources?: Record<string, unknown> } | null, artifact_blob_id: v.artifactBlobId },
          apiName,
        );
      } catch (e) {
        if (e instanceof FunctionArtifactError) {
          console.warn(
            `[functions/invoke] published artifact unavailable for ${apiName} ` +
              `at ${rid}@${branch}:${v.semver} — skipping version: [${e.code}] ${e.message}`,
          );
          artifactFailure ??= { semver: v.semver, code: e.code };
          continue;
        }
        throw e;
      }
      if (src === null) continue;
      if (chosen === null || compareSemver(parseSemver(v.semver), parseSemver(chosen.semver)) > 0) {
        chosen = { semver: v.semver, source: src };
      }
    }
    if (chosen === null) {
      if (artifactFailure) {
        return {
          kind: "error",
          errorName: "CodeRepos:PublishedArtifactMissing",
          parameters: {
            apiName,
            branch,
            semver: artifactFailure.semver,
            artifactErrorCode: artifactFailure.code,
            reason:
              `Published artifact for "${apiName}" (${artifactFailure.semver}) ` +
              `is missing from object storage — try republishing the release.`,
          },
        };
      }
      return { kind: "error", errorName: "CodeRepos:FunctionNotFound", parameters: { apiName, source: "published" } };
    }
    source = chosen.source;
    runtime = "NODE_20";
    resolvedPath = `published:${chosen.semver}`;
    } // end unpinned highest-semver Path B
  } else {
    const tree = await deps.stemma.listTree({
      repositoryRid: rid,
      branch,
      path: "",
      depth: 5,
    });
    if (tree.kind === "branch-not-found") {
      return { kind: "error", errorName: "CodeRepos:BranchNotFound", parameters: { branch } };
    }
    if (tree.kind !== "ok") {
      return { kind: "error", errorName: "CodeRepos:FunctionNotFound", parameters: { apiName } };
    }
    // apiName is the identity (path under src/functions/ without ext),
    // so nested functions resolve to src/functions/<identity>.{ts,py}.
    const FN_RE = new RegExp(
      `(^|\\/)src\\/functions\\/${apiName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(ts|py)$`,
    );
    let foundPath: string | null = null;
    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;
      const m = FN_RE.exec(entry.path);
      if (m === null) continue;
      if (entry.name.includes(".test.")) continue;
      foundPath = entry.path;
      runtime = m[2] === "py" ? "PY_311" : "NODE_20";
      break;
    }
    if (foundPath === null) {
      return { kind: "error", errorName: "CodeRepos:FunctionNotFound", parameters: { apiName } };
    }
    resolvedPath = foundPath;

    if (runtime !== "PY_311") {
      const blob = await deps.stemma.readBlob({
        repositoryRid: rid,
        branch,
        path: foundPath,
      });
      if (blob.kind === "branch-not-found") {
        return { kind: "error", errorName: "CodeRepos:BranchNotFound", parameters: { branch } };
      }
      if (blob.kind !== "ok") {
        return { kind: "error", errorName: "CodeRepos:FunctionNotFound", parameters: { apiName } };
      }
      source = new TextDecoder("utf-8").decode(blob.content);
    } else {
      source = ""; // unreachable; the runtime guard below short-circuits
    }
  }

  if (runtime === "PY_311") {
    return {
      kind: "error",
      errorName: "CodeRepos:RuntimeNotSupported",
      parameters: {
        apiName,
        runtime,
        reason:
          "Python runtime is not yet available in the in-browser sandbox. Publish via CI to invoke server-side.",
      },
    };
  }

  return { kind: "ok", source, runtime, resolvedPath, branch };
}

// ---------------------------------------------------------------------------
// Phase 3 — transpile.
// ---------------------------------------------------------------------------

export type TranspiledInvokeSource =
  | { kind: "ok"; transpiled: string }
  | { kind: "invalid"; errorName: CodeReposErrorName; parameters: Record<string, unknown> };

/**
 * Transpile TS → CommonJS via the isolated-module path (fast, no
 * type-check diagnostics blocking execution). Content-addressed by
 * (apiName, source) so a repeated invoke (the common case — Workshop
 * re-invokes the same committed function on every render + retry) skips
 * the transpile entirely.
 */
export function transpileForInvoke(apiName: string, source: string): TranspiledInvokeSource {
  // Escape-probe scan (defense-in-depth — see functionRuntime.ts): the
  // realm boundary already blocks constructor-chain escapes at runtime; this
  // makes naive probes fail LOUDLY at preview/invoke time instead.
  const escapeHits = scanSourceForEscapePatterns(source);
  if (escapeHits.length > 0) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:FunctionSourceRejected",
      parameters: {
        apiName,
        reason:
          "source contains sandbox escape probe pattern(s): " +
          escapeHits.join(", ") +
          " — not permitted in the Functions runtime",
      },
    };
  }
  const transpileKey = transpileCacheKey(apiName, source);
  let transpiled = transpileCache.get(transpileKey);
  if (transpiled === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ts = require("typescript") as typeof import("typescript");
      const out = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
          isolatedModules: true,
        },
        fileName: `${apiName}.ts`,
      });
      // TS may emit either `exports.<apiName>` (named exports) or
      // `exports.default` (default exports). Surface whichever is a
      // callable as the module's export so the sandbox picks it up.
      transpiled =
        out.outputText +
        `\nif (typeof module !== "undefined") {` +
        ` module.exports = ` +
        `(typeof exports[${JSON.stringify(apiName)}] === "function" ? exports[${JSON.stringify(apiName)}]` +
        ` : (typeof exports.default === "function" ? exports.default : module.exports));` +
        `}\n`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        kind: "invalid",
        errorName: "CodeRepos:FunctionCompileError",
        parameters: { apiName, reason: msg },
      };
    }
    transpileCache.set(transpileKey, transpiled);
  }
  return { kind: "ok", transpiled };
}

// ---------------------------------------------------------------------------
// Phase 4 — ontology snapshot.
// ---------------------------------------------------------------------------

export interface InvokeSnapshotResult {
  readonly snapshot: OntologySnapshot | undefined;
  readonly startedAt: number;
  readonly durationMs: number;
}

/**
 * Snapshot load is the single most expensive step on this path (up to a
 * 200k-row SELECT). Cached per (ontology, imported types) with a short
 * TTL so the burst of invokes one table render fires reuses one load.
 * The request's abort signal cancels the SELECT if the budget is
 * exceeded, instead of letting it run to completion after we 504.
 *
 * Throws the load error — the caller decides between silent return
 * (request already 504'd) and the 500 envelope.
 */
export async function loadInvokeSnapshot(
  pool: Pool,
  opts: {
    ontologyId: string | null;
    importedTypes: string[];
    importedLinkTypes: string[];
    timeoutSignal?: AbortSignal;
  },
): Promise<InvokeSnapshotResult> {
  const { ontologyId, importedTypes, importedLinkTypes } = opts;
  const snapshotKey = ontologyId
    ? `${ontologyId}:${[...importedTypes].sort().join(",")}|links:${[...importedLinkTypes].sort().join(",")}`
    : "";
  const startedAt = Date.now();
  let snapshot: OntologySnapshot | undefined =
    ontologyId ? snapshotCache.get(snapshotKey) : undefined;
  if (ontologyId && !snapshot) {
    const loaded = await loadOntologySnapshot(pool, {
      ontologyId,
      objectTypes: importedTypes,
      // Foundry parity: only DECLARED link-type imports are traversable.
      // A repo with zero link imports gets no link accessors — link
      // graph work is skipped entirely (zero added load cost).
      linkTypes: importedLinkTypes,
      signal: opts.timeoutSignal,
    });
    snapshotCache.set(snapshotKey, loaded);
    snapshot = loaded;
  }
  return { snapshot, startedAt, durationMs: Date.now() - startedAt };
}

