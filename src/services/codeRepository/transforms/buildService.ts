// ===========================================================================
// TransformBuildService — the Code-Repositories @transform build engine.
//
// Loop: read committed python at a ref -> discover @transform decorators ->
// validate + topologically order the DAG -> publish one job_spec per transform
// -> execute each (python3 sandbox) in dependency order -> materialize the
// OUTPUT dataset -> record input->output lineage. Build lifecycle is persisted
// in transform_build / transform_build_event with the same terminal-state
// guard as the orchestration engine (build-dispatcher).
// ===========================================================================
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pool } from "../../../db.js";
import type { StemmaAdapter } from "../adapters/types.js";
import { discoverTransforms, runtimeForDiscoveredBatch, type DiscoveredTransform, type TransformRuntime } from "./discovery.js";
import { validateProfile } from "./profileCatalog.js";
import { executeTransform, preflightTransformRuntime, executionMode, containerImageAvailable } from "./executor.js";
import { resolveRepoDeps } from "./runtimeConfig.js";
import { resolveDatasetByRid, resolvePreviousTransaction, resolveTransformInput, materializeOutput } from "./datasetStore.js";
import { resolveDatasetRef, isCatalogPath } from "./catalogPathResolver.js";
import {
  computeTransformIdentity,
  loadIncrementalState,
  resolveOutputDatasetId,
  upsertIncrementalState,
  type IncrementalStateRow,
} from "./transformIncrementalState.js";
import { type TransformPrincipal } from "./authz.js";
import { transformError, type TransformError } from "./errors.js";
import { publishJobSpecs } from "../../jobSpec/store.js";
import { validateJobSpec, detectCircularDependencies } from "../../jobSpec/validation.js";

export interface TransformBuildDeps {
  readonly stemma: StemmaAdapter;
}

export interface StartBuildArgs {
  readonly repositoryRid: string;
  readonly branch: string;
  readonly actor: string;
  /** P0 authz: the triggering user — read-checked on inputs, write-checked on
   * outputs. Persisted at enqueue so the boot-recovery path (rerunQueuedBuild)
   * can re-authorize without a request. */
  readonly principal: TransformPrincipal;
}

export interface StartBuildOk {
  readonly buildRid: string;
  readonly status: string;
  readonly transforms: number;
  /** True when an Idempotency-Key replay returned an already-existing build
   * (no new build was created). Callers return 200 (not 202) in that case. */
  readonly replayed?: boolean;
}

/** Either {ok} with a started build, or {error} with a §1.3 envelope. */
export type StartBuildResult =
  | { ok: true; value: StartBuildOk }
  | { ok: false; error: TransformError };

interface RepoFile {
  path: string;
  content: string;
}

function newBuildRid(): string {
  return `ri.transform.main.build.${crypto.randomUUID()}`;
}

/** Read all committed .py files under transforms/ or src/ at a ref, plus the
 * root `requirements.txt` (Gap 6) + `libs.txt` (Gap 7: library publishing). */
async function readRepoPyFiles(
  stemma: StemmaAdapter,
  repositoryRid: string,
  branch: string,
): Promise<
  | { kind: "ok"; files: RepoFile[]; commitSha: string; requirements: string | null; libs: string | null }
  | { kind: "branch-not-found" }
  | { kind: "error"; reason: string }
> {
  const tree = await stemma.listTree({ repositoryRid, branch, path: "", depth: 5 });
  if (tree.kind === "branch-not-found") return { kind: "branch-not-found" };
  if (tree.kind !== "ok") {
    return { kind: "error", reason: tree.kind === "transient" ? tree.reason : tree.kind };
  }
  const files: RepoFile[] = [];
  let requirements: string | null = null;
  let libs: string | null = null;
  for (const entry of tree.entries) {
    if (entry.type !== "blob") continue;
    if (entry.path === "requirements.txt") {
      const blob = await stemma.readBlob({ repositoryRid, branch, path: entry.path });
      if (blob.kind === "ok") requirements = new TextDecoder("utf-8").decode(blob.content);
      continue;
    }
    // Gap 7: a root-level libs.txt declares repo-to-repo library deps
    // (one `<name> <repoRid> <libPath>` per line).
    if (entry.path === "libs.txt") {
      const blob = await stemma.readBlob({ repositoryRid, branch, path: entry.path });
      if (blob.kind === "ok") libs = new TextDecoder("utf-8").decode(blob.content);
      continue;
    }
    if (!entry.path.endsWith(".py")) continue;
    if (!/(^|\/)(transforms|src)\//.test(entry.path)) continue;
    const blob = await stemma.readBlob({ repositoryRid, branch, path: entry.path });
    if (blob.kind !== "ok") continue;
    files.push({ path: entry.path, content: new TextDecoder("utf-8").decode(blob.content) });
  }
  const commitSha = /^[0-9a-f]{7,64}$/.test(tree.treeSha) ? tree.treeSha : tree.branchHead;
  return { kind: "ok", files, commitSha, requirements, libs };
}

// ---------------------------------------------------------------------------
// Gap 7: library publishing — repo-to-repo shared-module resolution.
//
// A repo B declares a `libs.txt` with one dep per line:
//   `<name> <publisherRepoRid> <libPath>`
// resolveLibs cross-reads each publisher repo's libPath at its master HEAD
// (every .py file under it) + returns the files so the executor can write them
// to <workdir>/libs/<name>/ + put <workdir>/libs on PYTHONPATH for B's driver.
// A missing/inaccessible publisher repo is a LOUD scheduling failure (503).
// ---------------------------------------------------------------------------
export interface ResolvedLib {
  readonly name: string;
  readonly files: ReadonlyArray<{ path: string; content: string }>;
}

export async function resolveLibs(
  stemma: StemmaAdapter,
  libsContent: string | null,
): Promise<{ ok: true; libs: ResolvedLib[] } | { ok: false; error: string }> {
  if (!libsContent || libsContent.trim().length === 0) return { ok: true, libs: [] };
  const out: ResolvedLib[] = [];
  for (const rawLine of libsContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) {
      return { ok: false, error: `libs.txt: malformed line (expected '<name> <repoRid> <libPath>'): ${rawLine}` };
    }
    const [name, publisherRid, libPath] = parts;
    const depBranch = parts[3] ?? "master";
    const tree = await stemma.listTree({ repositoryRid: publisherRid, branch: depBranch, path: libPath, depth: 4 });
    if (tree.kind === "branch-not-found") {
      return { ok: false, error: `libs.txt: publisher repo ${publisherRid} branch '${depBranch}' not found (dep '${name}')` };
    }
    if (tree.kind !== "ok") {
      return { ok: false, error: `libs.txt: cannot read publisher repo ${publisherRid} (dep '${name}'): ${tree.kind === "transient" ? tree.reason : tree.kind}` };
    }
    const libFiles: { path: string; content: string }[] = [];
    for (const entry of tree.entries) {
      if (entry.type !== "blob" || !entry.path.endsWith(".py")) continue;
      const blob = await stemma.readBlob({ repositoryRid: publisherRid, branch: depBranch, path: entry.path });
      if (blob.kind !== "ok") continue;
      // Rewrite the path to be relative to the libPath so it lands at
      // <workdir>/libs/<name>/<relative-path>.
      const rel = entry.path.startsWith(`${libPath}/`) ? entry.path.slice(libPath.length + 1) : entry.path;
      libFiles.push({ path: rel, content: new TextDecoder("utf-8").decode(blob.content) });
    }
    if (libFiles.length === 0) {
      return { ok: false, error: `libs.txt: publisher repo ${publisherRid} has no .py files under '${libPath}' (dep '${name}')` };
    }
    out.push({ name, files: libFiles });
  }
  return { ok: true, libs: out };
}

/**
 * Map a transform's Output write-mode (the value passed to Output.set_mode or
 * the `mode` arg of write_dataframe) to a dataset transaction type. Foundry
 * semantics: 'replace' -> SNAPSHOT (full replace); 'modify' / 'append' ->
 * APPEND. Anything else (including undefined, the default) -> SNAPSHOT.
 *
 * Extracted to a named helper so the mapping has a unit test — this is one of
 * the two spots where a bug would silently corrupt incremental write
 * semantics (the other is resolvePreviousTransaction).
 */
export function transactionTypeFor(
  writeMode: string | undefined | null,
): "SNAPSHOT" | "APPEND" {
  return writeMode === "modify" || writeMode === "append" ? "APPEND" : "SNAPSHOT";
}

/** Kahn topological order over output->input edges within the batch. */
export function topoOrder(transforms: DiscoveredTransform[]): DiscoveredTransform[] {
  const byOutput = new Map<string, DiscoveredTransform>();
  for (const t of transforms) byOutput.set(t.outputRid, t);

  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>(); // upstream output -> [downstream outputs]
  for (const t of transforms) {
    indeg.set(t.outputRid, indeg.get(t.outputRid) ?? 0);
    for (const inp of t.inputs) {
      if (byOutput.has(inp.rid)) {
        adj.set(inp.rid, [...(adj.get(inp.rid) ?? []), t.outputRid]);
        indeg.set(t.outputRid, (indeg.get(t.outputRid) ?? 0) + 1);
      }
    }
  }
  const queue = transforms.filter((t) => (indeg.get(t.outputRid) ?? 0) === 0).map((t) => t.outputRid);
  const ordered: DiscoveredTransform[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const t = byOutput.get(cur);
    if (t) ordered.push(t);
    for (const nxt of adj.get(cur) ?? []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) queue.push(nxt);
    }
  }
  // Any not ordered (shouldn't happen post cycle-check) appended stably.
  for (const t of transforms) if (!seen.has(t.outputRid)) ordered.push(t);
  return ordered;
}

async function appendEvent(
  buildRid: string,
  kind: "started" | "progress" | "log" | "succeeded" | "failed" | "cancelled",
  data: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO transform_build_event (build_rid, kind, data) VALUES ($1, $2, $3::jsonb)`,
    [buildRid, kind, JSON.stringify(data)],
  );
}

async function setTerminal(
  buildRid: string,
  status: "succeeded" | "failed" | "cancelled",
  reason: string | null,
  outputs: unknown[],
): Promise<boolean> {
  const upd = await pool.query(
    `UPDATE transform_build
        SET status = $2, ended_at = now(), reason = $3, outputs = $4::jsonb
      WHERE rid = $1 AND status IN ('queued','running')`,
    [buildRid, status, reason, JSON.stringify(outputs)],
  );
  if ((upd.rowCount ?? 0) === 0) return false;
  await appendEvent(buildRid, status === "succeeded" ? "succeeded" : "failed", {
    reason: reason ?? undefined,
    outputs,
  });
  return true;
}

/**
 * Validate a repo + discover its transforms, create a build row, and run the
 * build asynchronously. Returns the build handle (poll GET .../builds/:rid).
 */
export async function startBuild(
  deps: TransformBuildDeps,
  args: StartBuildArgs,
): Promise<StartBuildResult> {
  return prepareBuild(deps, args, {});
}

export interface RetryBuildArgs {
  readonly repositoryRid: string;
  readonly buildId: string;
  readonly actor: string;
  /** P0 authz: the CURRENT requester (the user clicking retry) — checked
   * against the inputs/outputs, not the original build's user. */
  readonly principal: TransformPrincipal;
  /** Idempotency-Key from the request header (a replay returns the existing build). */
  readonly idempotencyKey?: string | null;
}

/**
 * Retry a FAILED/cancelled/timeout build (Gap 2). Creates a fresh execution
 * of the original's repo+branch, linked to the original via retry_of, with
 * retry_count+1. Bounded by max_retries (429 at the cap). Idempotent via the
 * Idempotency-Key (a replay returns the existing retry, no duplicate). An
 * in-flight (queued/running) build cannot be retried (409) — retrying
 * mid-execution would race the running build.
 */
export async function retryBuild(
  deps: TransformBuildDeps,
  args: RetryBuildArgs,
): Promise<StartBuildResult> {
  const { repositoryRid, buildId, actor, principal, idempotencyKey } = args;
  const orig = await pool.query<{
    repository_rid: string;
    branch: string;
    status: string;
    retry_count: number;
    max_retries: number;
  }>(
    `SELECT repository_rid, branch, status, retry_count, max_retries
       FROM transform_build WHERE rid = $1 AND repository_rid = $2`,
    [buildId, repositoryRid],
  );
  if (orig.rowCount === 0) {
    return { ok: false, error: transformError("Transform:BuildNotFound", { buildRid: buildId }) };
  }
  const o = orig.rows[0];
  if (o.status === "queued" || o.status === "running") {
    return {
      ok: false,
      error: transformError("Transform:BuildConflict", {
        buildRid: buildId,
        status: o.status,
        message: `cannot retry a build that is still ${o.status}`,
      }),
    };
  }
  if (o.retry_count >= o.max_retries) {
    return {
      ok: false,
      error: transformError("Transform:TooManyRetries", {
        buildRid: buildId,
        retryCount: o.retry_count,
        maxRetries: o.max_retries,
        message: `build has been retried ${o.retry_count} time(s) (cap ${o.max_retries}); start a fresh build instead of retrying`,
      }),
    };
  }
  // Idempotency replay (before prepareBuild's own, so a replayed retry never
  // re-increments retry_count).
  if (idempotencyKey) {
    const existing = await pool.query<{ rid: string; status: string; transform_count: number }>(
      `SELECT rid, status, transform_count FROM transform_build WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const r = existing.rows[0];
      return {
        ok: true,
        value: { buildRid: r.rid, status: r.status, transforms: r.transform_count, replayed: true },
      };
    }
  }
  return prepareBuild(
    deps,
    { repositoryRid, branch: o.branch, actor, principal },
    {
      idempotencyKey: idempotencyKey ?? null,
      retryOf: buildId,
      retryCount: o.retry_count + 1,
      maxRetries: o.max_retries,
    },
  );
}

/** Options shared by start/retry. */
interface PrepareOpts {
  readonly idempotencyKey?: string | null;
  readonly retryOf?: string | null;
  readonly retryCount?: number;
  readonly maxRetries?: number;
}

/**
 * Shared prep: preflight the runtime, validate the repo, read committed .py,
 * discover + validate + cycle-check transforms, persist job_specs, insert the
 * build row (with retry metadata + idempotency key), and dispatch runBuild.
 * Extracted so startBuild and retryBuild share one enqueue path.
 */
async function prepareBuild(
  deps: TransformBuildDeps,
  args: StartBuildArgs,
  opts: PrepareOpts,
): Promise<StartBuildResult> {
  const { repositoryRid, branch, actor, principal } = args;

  // Idempotency replay: a build with this key already exists -> return it.
  if (opts.idempotencyKey) {
    const existing = await pool.query<{ rid: string; status: string; transform_count: number }>(
      `SELECT rid, status, transform_count FROM transform_build WHERE idempotency_key = $1`,
      [opts.idempotencyKey],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const r = existing.rows[0];
      return {
        ok: true,
        value: { buildRid: r.rid, status: r.status, transforms: r.transform_count, replayed: true },
      };
    }
  }

  // Gap 3 (sandboxed execution): if the operator opted into container mode,
  // the transform-runtime image MUST be present — a missing image is a LOUD
  // failure (503), never a silent fallback to host execution. An operator who
  // set TELLUS_TRANSFORM_EXECUTION_MODE=container expects isolation.
  //
  // This check MUST come before the host PySpark preflight below: in container
  // mode the driver + JVM run entirely inside the sandbox (the host merely
  // reads the mounted output CSV), so requiring a HOST pyspark venv would
  // wrongly 503 every build on a backend that has no host-side runtime —
  // exactly what the CI container-mode parity leg exercises.
  const containerMode = executionMode() === "container";
  if (containerMode) {
    const img = containerImageAvailable();
    if (!img.ok) {
      return {
        ok: false,
        error: transformError("Transform:RuntimeNotConfigured", {
          message: `container execution mode is on (TELLUS_TRANSFORM_EXECUTION_MODE=container) but the runtime image '${img.image}' is not present. Build it first: docker build -t ${img.image} -f scripts/transform-runtime.Dockerfile scripts. Detail: ${img.error ?? "image inspect failed"}`,
          python: "",
          javaHome: "",
        }),
      };
    }
  }

  // Preflight the PySpark runtime (pyspark + pandas + pyarrow importable +
  // java runs). This MUST happen before enqueueing the build so a
  // misconfigured backend fails the build LOUDLY with a 503
  // Transform:RuntimeNotConfigured carrying the exact reason + the fix
  // command — not the cryptic "No module named 'pyspark'" from the child.
  // LOCAL MODE ONLY — container builds execute inside the sandbox image and
  // must not depend on a host-side venv (see the container-mode block above).
  //
  // Track 1 (lightweight): every @transform still goes through the PySpark
  // shim today — the @lightweight decorator (transforms-python v3.0.0) uses
  // the same shared python venv + executor path; the lightweight runtime tag
  // is recorded on the build row (runtime='lightweight' when ALL discovered
  // transforms are @lightweight) for downstream tooling/FE/AIE; a future
  // iteration may swap in a no-JVM sidecar keyed on this tag (runtimeForBatch
  // + preflightLightweightRuntime in runtimeConfig.ts) without breaking
  // existing repos.
  if (!containerMode) {
    const rt = preflightTransformRuntime();
    if (!rt.ok) {
      return {
        ok: false,
        error: transformError("Transform:RuntimeNotConfigured", {
          message: rt.error ?? "PySpark runtime not configured",
          python: rt.python,
          javaHome: rt.javaHome ?? "",
        }),
      };
    }
  }

  const repo = await pool.query<{ state: string; display_name: string }>(
    `SELECT state, display_name FROM code_repository WHERE rid = $1 AND state IN ('ACTIVE','ARCHIVED')`,
    [repositoryRid],
  );
  if (repo.rowCount === 0) {
    return { ok: false, error: transformError("Transform:RepositoryNotFound", { rid: repositoryRid }) };
  }

  const read = await readRepoPyFiles(deps.stemma, repositoryRid, branch);
  if (read.kind === "branch-not-found") {
    return { ok: false, error: transformError("Transform:BranchNotFound", { branch }) };
  }
  if (read.kind === "error") {
    return { ok: false, error: transformError("Transform:Internal", { reason: read.reason }) };
  }

  const discovery = discoverTransforms(read.files);
  if (discovery.errors.length > 0 && discovery.transforms.length === 0) {
    return {
      ok: false,
      error: transformError("Transform:InvalidTransform", {
        branch,
        errors: discovery.errors,
      }),
    };
  }
  if (discovery.transforms.length === 0) {
    return { ok: false, error: transformError("Transform:NoTransformsToBuild", { branch }) };
  }

  // Track 1 (lightweight runtime selection): compute the build's runtime tag
  // from the discovered transforms' kinds. ALL-@lightweight → 'lightweight';
  // any Spark-backed decorator → 'spark' (the superset runtime — historical
  // builds are spark per migration 120's backfill). Recorded on
  // transform_build.runtime for downstream routing (FE, AIE, future no-JVM
  // executor swap-in). runtimeForDiscoveredBatch is the safe superset-by-default;
  // it honors transform.runtimeOverride (set by @transform.using / .spark.using /
  // stacked @lightweight) before falling back to runtimeFor(kind).
  const buildRuntime: TransformRuntime = runtimeForDiscoveredBatch(discovery.transforms);

  // @configure enforcement (gap 6): validate every transform's profile
  // against the catalog. Foundry rejects unknown profile names at scheduling
  // time — a real gate, pure logic, no cluster needed. (Mapping a validated
  // profile to actual driver/executor memory is a Spark-submit/cluster
  // concern, out of scope for local-mode.)
  for (const t of discovery.transforms) {
    const pv = validateProfile(t.profile);
    if (!pv.ok) {
      return {
        ok: false,
        error: transformError("Transform:InvalidTransform", {
          transform: t.name,
          reason: "JobSpec:InvalidProfile",
          unknownProfiles: pv.unknown,
          message: `@configure on '${t.name}' references unknown profile name(s): ${pv.unknown.join(", ")}`,
        }),
      };
    }
  }

  // Build job_spec payloads + validate + cycle-check. Phase 3 — resolve any
  // catalog-path /Project/Folder/Dataset references to canonical dataset RIDs
  // BEFORE the JobSpec validation (the validation regex requires a rid
  // literal). The original reference stays on DiscoveredTransform.outputs /
  // inputs for diagnostics/UI; the resolved RID flows through the job-spec.
  const specs: any[] = [];
  for (const t of discovery.transforms) {
    let outRid: string = t.outputRid;
      if (isCatalogPath(t.outputRid)) {
      const ref = await resolveDatasetRef(pool, t.outputRid, { branch });
      if (!ref.ok) {
        return {
          ok: false,
          error: transformError("Transform:InvalidTransform", {
            outputDatasetRid: t.outputRid,
            transform: t.name,
            catalogPath: t.outputRid,
            error: ref.error.error,
          }),
        };
      }
      outRid = ref.ref.rid;
    }
    const resolvedInputs: { datasetRid: string; branch: string; view: "incremental" | "snapshot" }[] = [];
    for (const i of t.inputs) {
      let iRid: string = i.rid;
        if (isCatalogPath(i.rid)) {
        const ref = await resolveDatasetRef(pool, i.rid, { branch });
        if (!ref.ok) {
          return {
            ok: false,
            error: transformError("Transform:InputDatasetNotFound", {
              inputRid: i.rid,
              transform: t.name,
              binding: i.param,
              catalogPath: i.rid,
              error: ref.error.error,
            }),
          };
        }
        iRid = ref.ref.rid;
      }
      resolvedInputs.push({
        datasetRid: iRid,
        branch,
        view: (t.incremental ? "incremental" : "snapshot") as "incremental" | "snapshot",
      });
    }
    specs.push({
      outputDatasetRid: outRid,
      sourcePath: t.sourcePath,
      entryPoint: t.name,
      inputs: resolvedInputs,
      parameters: {},
      computeProfile: "default",
    });
  }

  for (const spec of specs) {
    const v = validateJobSpec(spec);
    if (!v.ok) {
      return {
        ok: false,
        error: transformError("Transform:InvalidTransform", {
          outputDatasetRid: spec.outputDatasetRid,
          reason: v.errorName,
          parameters: v.parameters,
        }),
      };
    }
  }
  const cycle = detectCircularDependencies(specs);
  if (!cycle.ok) {
    return {
      ok: false,
      error: transformError("Transform:CircularDependency", { ...cycle.parameters }),
    };
  }

  // Gap 6 (per-repo reproducible env): resolve the repo's requirements.txt into
  // a content-hash-cached deps dir (pip install --target). Fail LOUDLY at
  // scheduling if a declared pkg cannot be installed (pip exit != 0) — a bad
  // requirements.txt never reaches execution. Cached: a second build with the
  // same requirements reuses the dir (no re-install).
  const repoDeps = resolveRepoDeps(read.requirements);
  if (repoDeps.error) {
    return {
      ok: false,
      error: transformError("Transform:RuntimeNotConfigured", {
        message: repoDeps.error,
        python: repoDeps.python,
        javaHome: "",
      }),
    };
  }

  // Gap 7 (library publishing): resolve the repo's libs.txt — cross-read each
  // publisher repo's lib module at its master HEAD. Fail LOUDLY at scheduling
  // if a publisher repo is missing/inaccessible (a declared dep that cannot be
  // resolved never reaches execution).
  const libsRes = await resolveLibs(deps.stemma, read.libs);
  if (!libsRes.ok) {
    return {
      ok: false,
      error: transformError("Transform:RuntimeNotConfigured", {
        message: libsRes.error,
        python: repoDeps.python,
        javaHome: "",
      }),
    };
  }

  // Persist job_specs (idempotent, immutability-fenced). Best-effort: a
  // rejection (output owned by another repo) surfaces but does not abort —
  // the build proceeds and the conflict is reported in events.
  let jobSpecRejected: unknown[] = [];
  try {
    const pub = await publishJobSpecs(pool, { repositoryRid, branch, commitSha: read.commitSha, specs });
    jobSpecRejected = pub.rejected as unknown[];
  } catch (e) {
    // Non-fatal for the build; recorded once the build row exists.
    jobSpecRejected = [{ error: String(e) }];
  }

  // Create the build row (with retry metadata + idempotency key for Gap 2).
  // P0 authz: persist the principal so the boot-recovery path
  // (rerunQueuedBuild) can re-authorize inputs/outputs without a request.
  // Track 1: persist the runtime tag (transform_build.runtime, migration 120)
  // so the FE / AIE / future no-JVM executor can route on lightweight vs spark.
  const buildRid = newBuildRid();
  await pool.query(
    `INSERT INTO transform_build
       (rid, repository_rid, branch, commit_sha, actor, status, transform_count,
        retry_of, retry_count, max_retries, idempotency_key, principal, runtime)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11, $12)`,
    [
      buildRid,
      repositoryRid,
      branch,
      read.commitSha,
      actor,
      discovery.transforms.length,
      opts.retryOf ?? null,
      opts.retryCount ?? 0,
      opts.maxRetries ?? 3,
      opts.idempotencyKey ?? null,
      JSON.stringify(principal),
      buildRuntime,
    ],
  );
  if (jobSpecRejected.length > 0) {
    await appendEvent(buildRid, "log", { jobSpecRejected });
  }

  // Run asynchronously; the route returns immediately and the client polls.
  void runBuild(buildRid, repositoryRid, branch, read.commitSha, actor, principal, read.files, [...discovery.transforms], read.requirements, libsRes.libs).catch(
    async (e) => {
      await setTerminal(buildRid, "failed", `internal error: ${String(e)}`, []).catch(() => undefined);
    },
  );

  return {
    ok: true,
    value: { buildRid, status: "queued", transforms: discovery.transforms.length, replayed: false },
  };
}

async function runBuild(
  buildRid: string,
  repositoryRid: string,
  branch: string,
  commitSha: string | null,
  actor: string,
  principal: TransformPrincipal,
  files: RepoFile[],
  transforms: DiscoveredTransform[],
  requirements: string | null,
  libs: ResolvedLib[],
): Promise<void> {
  const started = await pool.query(
    `UPDATE transform_build SET status='running', started_at=COALESCE(started_at, now())
      WHERE rid=$1 AND status='queued'`,
    [buildRid],
  );
  if ((started.rowCount ?? 0) === 0) return; // cancelled/lost
  await appendEvent(buildRid, "started", { transforms: transforms.length });

  const ordered = topoOrder(transforms);
  // Each entry carries BOTH the entry-point function name (`transform`) AND the
  // source-file basename (`sourceFile`) + repo-relative path (`sourcePath`).
  // The FE sidebar stage label prefers `sourceFile` so two transforms that
  // SHARE an entry-point name (e.g. two `def compute`) across files remain
  // distinguishable in the Build UI by their source file (the historical
  // disambiguator — pre-rename the function names also matched the file name,
  // so legacy builds look the same). Storing these in the build row's `outputs`
  // JSON preserves the names AT BUILD TIME — old rows aren't retroactively
  // renamed if the user later renames a function in a newer commit.
  const outputs: Array<{
    transform: string;
    sourcePath: string;
    sourceFile: string;
    outputRid: string;
    outputDatasetId: string;
    rowCount: number;
    columns: string[];
  }> = [];
  // Per-entry sourceFile derived from `t.sourcePath == path.basename(... '.py')`
  // — disambiguates failures when two transforms share an entry-point name.
  const failures: Array<{ transform: string; sourceFile: string; error: string }> = [];
  // Phase 6 — ctx.abort_job() whole-job abort records the per-transform
  // aborted name here; unlike `failures`, an abort does NOT advance to a
  // failed build — the build status records 'succeeded' with reason
  // 'aborted' (per Palantir Foundry's "Aborting transactions" reference:
  // aborted transactions show as grayed-out successful jobs).
  const abortedTransforms: string[] = [];

  // Each transform builds as its own unit (Foundry models each dataset as a
  // separate job): a failure in one is recorded and does not abort siblings.
  for (const t of ordered) {
    // Foundry-bridge inputs are staged from object storage to temp CSVs the
    // driver reads; declared here (before the try) so the finally below can
    // clean them on every exit (success, a thrown error, or a `continue`).
    const stagedPaths: string[] = [];
    try {
      // Resolve inputs (may be a prior transform's just-materialized output).
      const bindings: Array<{ param: string; rid: string; path: string; datasetId: string; origin: "dataset-table" | "foundry-bridge"; previousPath: string | null }> = [];
      let missingInput: string | null = null;
      for (const inp of t.inputs) {
        // Phase 3 — Catalog path → RID. If the discovered reference is a
        // catalog path (Input("/Project/Folder/Dataset")), resolve it to the
        // canonical dataset RID via the resources tree BEFORE calling
        // resolveTransformInput (which expects a RID). RID refs are
        // unchanged (the dataset table's identity column). Resolution
        // preserves the original path on the binding for diagnostics/UI.
        let datasetRid = inp.rid;
        if (isCatalogPath(inp.rid)) {
          const ref = await resolveDatasetRef(pool, inp.rid, { branch });
          if (!ref.ok) {
            missingInput =
              `input catalog path '${inp.rid}' (param '${inp.param}') could not ` +
              `be resolved: ${ref.error.error}`;
            break;
          }
          datasetRid = ref.ref.rid;
        }
        // resolveTransformInput bridges the `dataset` table (transform/upload
        // datasets, on-disk) AND the Foundry catalog `foundry_datasets` (UUID
        // rids, object storage — staged to a temp CSV the driver reads). This is
        // what lets a build consume a catalog CSV Input("ri.foundry.main.dataset.
        // <uuid>") — the same bridge the dataset-preview UI already uses.
        const resolved = await resolveTransformInput(datasetRid, branch, principal);
        if (!resolved) {
          missingInput = `input dataset not found: ${datasetRid} (param '${inp.param}'; original ref '${inp.rid}')`;
          break;
        }
        if (resolved.stagedPath) stagedPaths.push(resolved.stagedPath);
        // Previous committed transaction (for Input.dataframe(mode='previous')).
        // Foundry-bridge inputs are single-version catalog files → no previous
        // transaction (resolvePreviousTransaction is dataset-table-only → null).
        const previous = await resolvePreviousTransaction(datasetRid, branch);
        bindings.push({ param: inp.param, rid: datasetRid, path: resolved.filePath, datasetId: resolved.datasetId, origin: resolved.origin, previousPath: previous?.filePath ?? null });
      }
      if (missingInput) {
        const f = t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name;
        failures.push({ transform: t.name, sourceFile: f, error: missingInput });
        await appendEvent(buildRid, "log", { phase: "skipped", transform: t.name, sourceFile: f, error: missingInput });
        continue;
      }

      // An incremental build = the output dataset already has at least one
      // prior committed transaction (a previous build materialized it).
      // NOTE: this is an EXISTENCE check (OFFSET 0 / count >= 1), NOT the
      // second-newest tx — using OFFSET 1 here was a bug that left
      // is_incremental=false on build 2 (only 1 prior tx -> OFFSET 1 -> null),
      // so the second build ran a full SNAPSHOT instead of APPEND. The
      // second-newest (resolvePreviousTransaction, OFFSET 1) is only for
      // Input.dataframe(mode='previous') — the input's *prior version* — which
      // is a different question (previousPath on each input binding below).
      //
      // Phase 3 — output RID resolution: catalog paths (Output("/path...")) are
      // resolved to canonical RIDs via the resources tree. The original
      // reference is preserved on the DiscoveredTransform.outputs[].rid for
      // diagnostics/UI; only the canonical RID flows to resolveDatasetByRid
      // + materializeOutput.
      let outputDatasetRid: string = t.outputRid;
      if (isCatalogPath(t.outputRid)) {
        const ref = await resolveDatasetRef(pool, t.outputRid, { branch });
        if (!ref.ok) {
          failures.push({
            transform: t.name,
            sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
            error: `output catalog path '${t.outputRid}' could not be resolved: ${ref.error.error}`,
          });
          await appendEvent(buildRid, "log", {
            phase: "failed",
            transform: t.name,
            sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
            error: `output catalog path '${t.outputRid}' could not be resolved: ${ref.error.error}`,
          });
          continue;
        }
        outputDatasetRid = ref.ref.rid;
      }
      const isIncremental = !!(await resolveDatasetByRid(outputDatasetRid, branch));

      // ---------------------------------------------------------------------
      // Phase 4 — incremental state machine (buildService.ts ↔
      // transform_incremental_state via transformIncrementalState.ts):
      //
      // For the FIRST build (no prior `dataset` row for the output RID), there
      // is no `output_dataset_id` to seed the state row, so the state machine
      // is skipped — the materializeOutput below creates the dataset_row, and
      // the post-commit upsert inserts a fresh state row with the discovered
      // @incremental config snapshot + last_semantic_version=current.
      //
      // For subsequent builds: load the prior row, compare the discovered
      // `@incremental(semantic_version=N)` to the persisted
      // `last_semantic_version`. A mismatch (semantic_version bump) forces
      // SNAPSHOT recompute: `exec.isIncremental=false` AND every input is
      // flagged 'view=snapshot' (pad of the snapshot_inputs override). After a
      // committed commit, the row's last_semantic_version is advanced to
      // semantic_version (matches the Palantir one-shot reset behavior).
      //
      // Aborts/failures leave the row UNCHANGED (per Palantir §6) — the next
      // build reprocesses the same uncommitted input changes; the high-water
      // mark (`last_committed_output_transaction_id` +
      // `input_transaction_state`) only advances on a real committed build.
      // ---------------------------------------------------------------------
      const transformIdentity = computeTransformIdentity(t.sourcePath, t.name);
      const currentSemanticVersion = t.incrementalSemanticVersion ?? 1;
      const prevOutputDatasetId = await resolveOutputDatasetId(outputDatasetRid, branch);
      let prevState: IncrementalStateRow | null = null;
      if (prevOutputDatasetId) {
        prevState = await loadIncrementalState({
          transformIdentity,
          repositoryRid,
          branch,
          outputDatasetId: prevOutputDatasetId,
        });
      }
      // forceSnapshot flips when the persisted last_semantic_version differs
      // from the discovered semantic_version (a deliberate bump).
      const forceSnapshot = !!prevState && prevState.last_semantic_version !== currentSemanticVersion;
      const effectiveIsIncremental = isIncremental && !forceSnapshot;

      await appendEvent(buildRid, "progress", { phase: "executing", transform: t.name });

      const exec = await executeTransform({
        transform: t,
        files,
        inputs: bindings.map((b) => ({ param: b.param, rid: b.rid, path: b.path, format: "csv", previousPath: b.previousPath })),
        isIncremental: effectiveIsIncremental,
        requirementsContent: requirements,
        libs,
      });
      // Phase 6 — ctx.abort_job() whole-job abort: a SUCCESSFUL-but-aborted
      // transform commits NO output transaction and is NOT propagated as a
      // runtime failure. The Python driver returned ok=true + aborted=true
      // (caught AbortJobError in driver.py); the executor surfaced both
      // flags to ExecuteResult. We record an "aborted" build-phase event and
      // SKIP materializeOutput + the lineage-edge insert entirely. Downstream
      // datasets are not marked stale (no new transaction was committed), and
      // the previous committed output's incremental checkpoint is preserved
      // (Phase 4 state machine leaf — the input_transaction_state pointer is
      // NOT advanced on an aborted build, so the next build reprocesses the
      // same uncommitted input changes per Palantir §6).
      if (exec.aborted) {
        abortedTransforms.push(t.name);
        await appendEvent(buildRid, "log", {
          phase: "aborted",
          transform: t.name,
          sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
          message: "transform called ctx.abort_job(); no output transaction committed",
        });
        continue;
      }
      if (!exec.ok || !exec.outputPath) {
        const f = t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name;
        failures.push({ transform: t.name, sourceFile: f, error: exec.error ?? "execution failed" });
        await appendEvent(buildRid, "log", {
          phase: "failed",
          transform: t.name,
          sourceFile: f,
          error: exec.error,
          stderr: exec.stderr.slice(0, 4000),
          traceback: exec.traceback?.slice(0, 4000),
        });
        continue;
      }

      // Materialize the OUTPUT dataset. The transform's set_mode/write_dataframe
      // mode drives the transaction type: 'replace' -> SNAPSHOT, 'modify'/'append'
      // -> APPEND (Foundry incremental write semantics). Phase 3 routes the
      // canonical RID (resolved above for catalog paths) into materializeOutput
      // — the function delegates to resolveDatasetByRid internally too.
      const mat = await materializeOutput({
        rid: outputDatasetRid,
        name: t.name,
        description: `Output of transform '${t.name}' in ${repositoryRid}`,
        csvFilePath: exec.outputPath,
        transactionType: transactionTypeFor(exec.writeMode),
        actor,
        principal,
        branch,
        buildRid,
      });

      // Record input->output lineage edges.
      for (const b of bindings) {
        // Skip self-edges defensively, AND foundry-bridge inputs: their
        // datasetId is the foundry_datasets UUID, NOT a `dataset.dataset_id`,
        // so the transform_lineage.input_dataset_id FK would reject the insert.
        // (Foundry catalog inputs have no dataset-table identity to lineage
        // against; their rid is still carried on the binding for display.)
        if (b.datasetId === mat.datasetId || b.origin === "foundry-bridge") continue;
        await pool.query(
          `INSERT INTO transform_lineage
             (output_dataset_id, input_dataset_id, repository_rid, branch, transform_name, build_rid)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (output_dataset_id, input_dataset_id, branch) DO UPDATE
             SET build_rid = EXCLUDED.build_rid, transform_name = EXCLUDED.transform_name`,
          [mat.datasetId, b.datasetId, repositoryRid, branch, t.name, buildRid],
        );
      }

      outputs.push({
        transform: t.name,
        sourcePath: t.sourcePath,
        sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
        outputRid: t.outputRid,
        outputDatasetId: mat.datasetId,
        rowCount: mat.rowCount,
        columns: mat.columns,
      });
      await appendEvent(buildRid, "progress", {
        phase: "materialized",
        transform: t.name,
        sourcePath: t.sourcePath,
        sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
        outputDatasetId: mat.datasetId,
        rowCount: mat.rowCount,
      });

      // -------------------------------------------------------------------
      // Phase 4 — post-commit upsert of transform_incremental_state.
      //
      // After a successful commit, advance the persisted pointers:
      //   - last_semantic_version  ← currentSemanticVersion (clamps even if
      //     unchanged — matches Palantir "post-snapshot, last_semantic_version
      //     catches up").
      //   - last_build_rid          ← buildRid
      //   - last_build_status       ← 'committed'
      //   - input_transaction_state ← { "<input_dataset_id>": "<latest tx_id>" }
      //     for each BINDING (dataset-table inputs only; foundry-bridge inputs
      //     have no `dataset_transaction` history and are skipped).
      //   - last_committed_output_transaction_id ← mat.transactionId
      //   - last_commit_sha         ← commitSha (passed through runBuild from
      //     the build row's input ref).
      //
      // Failures/aborts above `continue` BEFORE reaching this block, leaving
      // the prior state row's high-water marks untouched → next build
      // reprocesses the same uncommitted input changes (Palantir §6).
      // -------------------------------------------------------------------
      const inputTxState: Record<string, string> = {};
      for (const b of bindings) {
        if (b.origin === "foundry-bridge") continue;
        // Skip self-write (transform outputting itself / no input) —
        // `b.datasetId === mat.datasetId` doesn't appear here because lineage
        // skip covers that, but defensively don't pollute state with the
        // self-output as input.
        if (b.datasetId === mat.datasetId) continue;
        const latestTx = await pool.query<{ transaction_id: string }>(
          `SELECT transaction_id
             FROM dataset_transaction
            WHERE dataset_id = $1
              AND branch IS NOT DISTINCT FROM $2
              AND status = 'committed'
            ORDER BY committed_at DESC NULLS LAST
            LIMIT 1`,
          [b.datasetId, branch],
        );
        if (latestTx.rows.length > 0) {
          inputTxState[b.datasetId] = latestTx.rows[0].transaction_id;
        }
      }
      try {
        await upsertIncrementalState({
          transformIdentity,
          repositoryRid,
          branch,
          outputDatasetId: mat.datasetId,
          entryPoint: t.name,
          sourcePath: t.sourcePath,
          requireIncremental: t.incrementalRequireIncremental ?? false,
          semanticVersion: currentSemanticVersion,
          snapshotInputs: t.incrementalSnapshotInputs ?? [],
          allowRetention: t.incrementalAllowRetention ?? false,
          strictAppend: t.incrementalStrictAppend ?? false,
          v2Semantics: t.incrementalV2Semantics ?? false,
          lastSemanticVersion: currentSemanticVersion,
          lastBuildRid: buildRid,
          lastBuildStatus: "committed",
          inputTransactionState: inputTxState,
          lastCommittedOutputTransactionId: mat.transactionId,
          lastCommitSha: commitSha,
        });
      } catch (stateErr) {
        // A state-row write failure MUST NOT mark a successful commit as
        // failed — the output transaction is already committed; the user
        // sees a successful build. Log + carry on; the next build re-tries
        // the upsert (ON CONFLICT DO UPDATE is idempotent).
        await appendEvent(buildRid, "log", {
          phase: "warning",
          transform: t.name,
          message: `transform_incremental_state upsert failed: ${String(stateErr)}`,
        });
      }
    } catch (e) {
      failures.push({
        transform: t.name,
        sourceFile: t.sourcePath ? path.basename(t.sourcePath, ".py") : t.name,
        error: String(e),
      });
      await appendEvent(buildRid, "log", { phase: "failed", transform: t.name, error: String(e) });
    } finally {
      // Clean any staged foundry-bridge input temp files for THIS transform
      // (the python driver has finished — success, failure, or a thrown error).
      // On a partial resolution (input[0] staged then input[1] missing → break),
      // stagedPaths holds input[0]'s temp + this finally cleans it (no leak).
      for (const p of stagedPaths) {
        try { fs.rmSync(path.dirname(p), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  if (failures.length === 0) {
    // Phase 6 — when at least one transform aborted and none failed, the
    // build status is SUCCEEDED with `reason='aborted'` (per Palantir's
    // "Aborting transactions" reference). The outputs array stays empty
    // since the abort path skips materializeOutput AND lineage-edge
    // insertion; downstreams are NOT marked stale (no transaction committed).
    // Some builds may have ALL transforms aborted (a clean no-op day) — that
    // is `reason='aborted'` with an empty outputs array. Other builds may
    // have a mix of aborted-with-OK-materialized transforms; the OK ones pass
    // through the normal materialize path and show in `outputs`.
    if (abortedTransforms.length > 0) {
      const reason = abortedTransforms.length === outputs.length
        ? `all ${abortedTransforms.length} transform(s) aborted via ctx.abort_job() (no output committed)`
        : `${outputs.length} transform(s) committed; ${abortedTransforms.length} aborted via ctx.abort_job() (${abortedTransforms.join(", ")})`;
      await setTerminal(buildRid, "succeeded", reason, outputs);
    } else {
      await setTerminal(buildRid, "succeeded", null, outputs);
    }
  } else {
    const reason =
      outputs.length + abortedTransforms.length > 0
        ? `${outputs.length} transform(s) succeeded, ${abortedTransforms.length} aborted, ${failures.length} failed: ` +
          failures.map((f) => `${f.sourceFile ?? f.transform} (${f.error})`).join("; ")
        : failures.map((f) => `${f.sourceFile ?? f.transform} (${f.error})`).join("; ");
    await setTerminalWithFailures(buildRid, reason, outputs, failures);
  }
}

async function setTerminalWithFailures(
  buildRid: string,
  reason: string,
  outputs: unknown[],
  failures: unknown[],
): Promise<void> {
  const upd = await pool.query(
    `UPDATE transform_build
        SET status = 'failed', ended_at = now(), reason = $2, outputs = $3::jsonb
      WHERE rid = $1 AND status IN ('queued','running')`,
    [buildRid, reason, JSON.stringify(outputs)],
  );
  if ((upd.rowCount ?? 0) === 0) return;
  await appendEvent(buildRid, "failed", { reason, outputs, failures });
}

// ===========================================================================
// Gap 2: idempotent recovery of 'queued' builds at boot.
//
// A 'queued' build was enqueued but runBuild never advanced it past the
// status='running' UPDATE — the process died before execution began, so there
// is no partial output state. It is safe to re-run from scratch (equivalent to
// an explicit retry, but automatic + bounded by the build's own max_retries is
// NOT incremented — this is recovery of a build that never ran, not a retry).
// 'running' builds are NOT re-queued (mid-execution resume is unsafe); the
// crash-sweeper marks them 'failed'.
// ===========================================================================

/** Re-run a single 'queued' build: re-read committed .py at its branch,
 * re-discover, dispatch runBuild. Returns false if the build is gone, not
 * 'queued' (raced/swept), or could not be read (then it is marked failed). */
export async function rerunQueuedBuild(
  deps: TransformBuildDeps,
  buildRid: string,
): Promise<boolean> {
  const row = await pool.query<{
    repository_rid: string;
    branch: string;
    commit_sha: string | null;
    actor: string;
    status: string;
    principal: unknown;
  }>(
    `SELECT repository_rid, branch, commit_sha, actor, status, principal FROM transform_build WHERE rid = $1`,
    [buildRid],
  );
  if (row.rowCount === 0) return false;
  const b = row.rows[0];
  if (b.status !== "queued") return false; // raced: swept or already running
  // P0 authz: re-authorize against the persisted principal (the triggering
  // user). Pre-migration rows backfill to {userId: actor, roles: []}; JSONB
  // may arrive parsed (object) or as a string depending on the pg parser.
  const principal: TransformPrincipal = (() => {
    const p = b.principal;
    if (!p) return { userId: b.actor, roles: [] };
    const obj = typeof p === "string" ? (JSON.parse(p) as TransformPrincipal) : (p as TransformPrincipal);
    return { userId: obj.userId ?? b.actor, roles: Array.isArray(obj.roles) ? obj.roles : [] };
  })();

  const read = await readRepoPyFiles(deps.stemma, b.repository_rid, b.branch);
  if (read.kind !== "ok") {
    await setTerminal(
      buildRid,
      "failed",
      `requeue failed: could not read repository (${read.kind === "branch-not-found" ? "branch-not-found" : read.reason})`,
      [],
    ).catch(() => undefined);
    return false;
  }
  const discovery = discoverTransforms(read.files);
  if (discovery.transforms.length === 0) {
    await setTerminal(
      buildRid,
      "failed",
      "requeue failed: no transforms discovered",
      [],
    ).catch(() => undefined);
    return false;
  }
  // Gap 7: re-resolve libs at requeue time (best-effort; a failed lib resolution
  // fails the build loudly rather than silently dropping the dep).
  const libsRes = await resolveLibs(deps.stemma, read.libs);
  if (!libsRes.ok) {
    await setTerminal(buildRid, "failed", `requeue failed: ${libsRes.error}`, []).catch(() => undefined);
    return false;
  }
  void runBuild(buildRid, b.repository_rid, b.branch, b.commit_sha, b.actor, principal, read.files, [...discovery.transforms], read.requirements, libsRes.libs).catch(
    async (e) => {
      await setTerminal(buildRid, "failed", `internal error: ${String(e)}`, []).catch(() => undefined);
    },
  );
  return true;
}

/** Boot-time recovery: re-queue every 'queued' build (the process died before
 * execution began; safe to re-run). Returns the count re-queued. Called after
 * sweepStaleTransformBuilds() on boot. */
export async function requeueQueuedBuilds(deps: TransformBuildDeps): Promise<number> {
  const rows = await pool.query<{ rid: string }>(
    `SELECT rid FROM transform_build WHERE status = 'queued' ORDER BY enqueued_at ASC`,
  );
  let n = 0;
  for (const r of rows.rows) {
    try {
      const ok = await rerunQueuedBuild(deps, r.rid);
      if (ok) n++;
    } catch (e) {
      console.error(`[transforms] requeue of ${r.rid} failed:`, String(e));
    }
  }
  return n;
}
