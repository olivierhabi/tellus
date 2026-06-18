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
import { pool } from "../../../db.js";
import type { StemmaAdapter } from "../adapters/types.js";
import { discoverTransforms, type DiscoveredTransform } from "./discovery.js";
import { executeTransform, pythonAvailable } from "./executor.js";
import { resolveDatasetByRid, materializeOutput } from "./datasetStore.js";
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
}

export interface StartBuildOk {
  readonly buildRid: string;
  readonly status: string;
  readonly transforms: number;
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

/** Read all committed .py files under transforms/ or src/ at a ref. */
async function readRepoPyFiles(
  stemma: StemmaAdapter,
  repositoryRid: string,
  branch: string,
): Promise<
  | { kind: "ok"; files: RepoFile[]; commitSha: string }
  | { kind: "branch-not-found" }
  | { kind: "error"; reason: string }
> {
  const tree = await stemma.listTree({ repositoryRid, branch, path: "", depth: 5 });
  if (tree.kind === "branch-not-found") return { kind: "branch-not-found" };
  if (tree.kind !== "ok") {
    return { kind: "error", reason: tree.kind === "transient" ? tree.reason : tree.kind };
  }
  const files: RepoFile[] = [];
  for (const entry of tree.entries) {
    if (entry.type !== "blob") continue;
    if (!entry.path.endsWith(".py")) continue;
    if (!/(^|\/)(transforms|src)\//.test(entry.path)) continue;
    const blob = await stemma.readBlob({ repositoryRid, branch, path: entry.path });
    if (blob.kind !== "ok") continue;
    files.push({ path: entry.path, content: new TextDecoder("utf-8").decode(blob.content) });
  }
  // treeSha is a content-pinned hex identifier; fall back to branchHead.
  const commitSha = /^[0-9a-f]{7,64}$/.test(tree.treeSha) ? tree.treeSha : tree.branchHead;
  return { kind: "ok", files, commitSha };
}

/** Kahn topological order over output->input edges within the batch. */
function topoOrder(transforms: DiscoveredTransform[]): DiscoveredTransform[] {
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
  const { repositoryRid, branch, actor } = args;

  const py = pythonAvailable();
  if (!py.ok) {
    return {
      ok: false,
      error: transformError("Transform:Internal", {
        message: `python3 runtime unavailable: ${py.error ?? "not found"}`,
      }),
    };
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

  // Build job_spec payloads + validate + cycle-check.
  const specs = discovery.transforms.map((t) => ({
    outputDatasetRid: t.outputRid,
    sourcePath: t.sourcePath,
    entryPoint: t.name,
    inputs: t.inputs.map((i) => ({
      datasetRid: i.rid,
      branch,
      view: (t.incremental ? "incremental" : "snapshot") as "incremental" | "snapshot",
    })),
    parameters: {},
    computeProfile: "default",
  }));

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

  // Create the build row.
  const buildRid = newBuildRid();
  await pool.query(
    `INSERT INTO transform_build
       (rid, repository_rid, branch, commit_sha, actor, status, transform_count)
     VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
    [buildRid, repositoryRid, branch, read.commitSha, actor, discovery.transforms.length],
  );
  if (jobSpecRejected.length > 0) {
    await appendEvent(buildRid, "log", { jobSpecRejected });
  }

  // Run asynchronously; the route returns immediately and the client polls.
  void runBuild(buildRid, repositoryRid, branch, actor, read.files, [...discovery.transforms]).catch(
    async (e) => {
      await setTerminal(buildRid, "failed", `internal error: ${String(e)}`, []).catch(() => undefined);
    },
  );

  return {
    ok: true,
    value: { buildRid, status: "queued", transforms: discovery.transforms.length },
  };
}

async function runBuild(
  buildRid: string,
  repositoryRid: string,
  branch: string,
  actor: string,
  files: RepoFile[],
  transforms: DiscoveredTransform[],
): Promise<void> {
  const started = await pool.query(
    `UPDATE transform_build SET status='running', started_at=COALESCE(started_at, now())
      WHERE rid=$1 AND status='queued'`,
    [buildRid],
  );
  if ((started.rowCount ?? 0) === 0) return; // cancelled/lost
  await appendEvent(buildRid, "started", { transforms: transforms.length });

  const ordered = topoOrder(transforms);
  const outputs: Array<{
    transform: string;
    outputRid: string;
    outputDatasetId: string;
    rowCount: number;
    columns: string[];
  }> = [];
  const failures: Array<{ transform: string; error: string }> = [];

  // Each transform builds as its own unit (Foundry models each dataset as a
  // separate job): a failure in one is recorded and does not abort siblings.
  for (const t of ordered) {
    try {
      // Resolve inputs (may be a prior transform's just-materialized output).
      const bindings: Array<{ param: string; rid: string; path: string; datasetId: string }> = [];
      let missingInput: string | null = null;
      for (const inp of t.inputs) {
        const resolved = await resolveDatasetByRid(inp.rid);
        if (!resolved) {
          missingInput = `input dataset not found: ${inp.rid} (param '${inp.param}')`;
          break;
        }
        bindings.push({ param: inp.param, rid: inp.rid, path: resolved.filePath, datasetId: resolved.datasetId });
      }
      if (missingInput) {
        failures.push({ transform: t.name, error: missingInput });
        await appendEvent(buildRid, "log", { phase: "skipped", transform: t.name, error: missingInput });
        continue;
      }

      await appendEvent(buildRid, "progress", { phase: "executing", transform: t.name });

      const exec = await executeTransform({
        transform: t,
        files,
        inputs: bindings.map((b) => ({ param: b.param, rid: b.rid, path: b.path, format: "csv" })),
      });
      if (!exec.ok || !exec.outputPath) {
        failures.push({ transform: t.name, error: exec.error ?? "execution failed" });
        await appendEvent(buildRid, "log", {
          phase: "failed",
          transform: t.name,
          error: exec.error,
          stderr: exec.stderr.slice(0, 4000),
          traceback: exec.traceback?.slice(0, 4000),
        });
        continue;
      }

      // Materialize the OUTPUT dataset (SNAPSHOT, or APPEND for incremental).
      const mat = await materializeOutput({
        rid: t.outputRid,
        name: t.name,
        description: `Output of transform '${t.name}' in ${repositoryRid}`,
        csvFilePath: exec.outputPath,
        transactionType: t.incremental ? "APPEND" : "SNAPSHOT",
        actor,
      });

      // Record input->output lineage edges.
      for (const b of bindings) {
        if (b.datasetId === mat.datasetId) continue; // skip self-edges defensively
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
        outputRid: t.outputRid,
        outputDatasetId: mat.datasetId,
        rowCount: mat.rowCount,
        columns: mat.columns,
      });
      await appendEvent(buildRid, "progress", {
        phase: "materialized",
        transform: t.name,
        outputDatasetId: mat.datasetId,
        rowCount: mat.rowCount,
      });
    } catch (e) {
      failures.push({ transform: t.name, error: String(e) });
      await appendEvent(buildRid, "log", { phase: "failed", transform: t.name, error: String(e) });
    }
  }

  if (failures.length === 0) {
    await setTerminal(buildRid, "succeeded", null, outputs);
  } else {
    const reason =
      outputs.length > 0
        ? `${outputs.length} transform(s) succeeded, ${failures.length} failed: ` +
          failures.map((f) => `${f.transform} (${f.error})`).join("; ")
        : failures.map((f) => `${f.transform} (${f.error})`).join("; ");
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
