// B7 — JobSpec validation: entry-point regex + circular dependency detection.
//
// Pure logic — no I/O.

export const ENTRY_POINT_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.]{0,255}(:[a-zA-Z_][a-zA-Z0-9_]{0,127})?$/;
export const DATASET_RID_REGEX = /^ri\.[a-z][a-z0-9-]{0,127}\.[a-z][a-z0-9-]{0,127}\.[a-z][a-z0-9_-]{0,127}\.[a-zA-Z0-9_-]{1,128}$/;
export const COMMIT_SHA_REGEX = /^[0-9a-f]{7,64}$/;
export const BRANCH_REGEX = /^[a-zA-Z0-9._/-]{1,255}$/;

export interface InputSpec {
  readonly datasetRid: string;
  readonly branch: string;
  readonly view: "snapshot" | "incremental";
}

export interface JobSpecPayload {
  readonly outputDatasetRid: string;
  readonly sourcePath: string;
  readonly entryPoint: string;
  readonly inputs: ReadonlyArray<InputSpec>;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly computeProfile: string;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorName: "JobSpec:InvalidArgument" | "JobSpec:InvalidEntryPoint" | "JobSpec:CircularDependency"; readonly parameters: Record<string, unknown> };

export function validateEntryPoint(entryPoint: string): ValidationResult {
  if (typeof entryPoint !== "string" || entryPoint.length === 0 || entryPoint.length > 384) {
    return { ok: false, errorName: "JobSpec:InvalidEntryPoint", parameters: { reason: "empty-or-too-long" } };
  }
  if (!ENTRY_POINT_REGEX.test(entryPoint)) {
    return { ok: false, errorName: "JobSpec:InvalidEntryPoint", parameters: { reason: "regex-mismatch" } };
  }
  return { ok: true };
}

export function validateDatasetRid(rid: string, field: string): ValidationResult {
  if (!DATASET_RID_REGEX.test(rid)) {
    return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-dataset-rid", field } };
  }
  return { ok: true };
}

export function validateCommitSha(sha: string): ValidationResult {
  if (!COMMIT_SHA_REGEX.test(sha)) {
    return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-commit-sha" } };
  }
  return { ok: true };
}

export function validateBranch(branch: string): ValidationResult {
  if (!BRANCH_REGEX.test(branch)) {
    return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-branch" } };
  }
  return { ok: true };
}

/**
 * Validate a single JobSpec payload (entry point + dataset rids + branches).
 */
export function validateJobSpec(spec: JobSpecPayload): ValidationResult {
  const ep = validateEntryPoint(spec.entryPoint);
  if (!ep.ok) return ep;
  const od = validateDatasetRid(spec.outputDatasetRid, "outputDatasetRid");
  if (!od.ok) return od;
  for (let i = 0; i < spec.inputs.length; i++) {
    const inp = spec.inputs[i];
    const inRid = validateDatasetRid(inp.datasetRid, `inputs[${i}].datasetRid`);
    if (!inRid.ok) return inRid;
    const inBr = validateBranch(inp.branch);
    if (!inBr.ok) return inBr;
    if (inp.view !== "snapshot" && inp.view !== "incremental") {
      return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-view", index: i } };
    }
  }
  if (typeof spec.sourcePath !== "string" || spec.sourcePath.length === 0 || spec.sourcePath.length > 1024) {
    return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-source-path" } };
  }
  if (typeof spec.computeProfile !== "string" || spec.computeProfile.length === 0 || spec.computeProfile.length > 64) {
    return { ok: false, errorName: "JobSpec:InvalidArgument", parameters: { reason: "invalid-compute-profile" } };
  }
  return { ok: true };
}

/**
 * Detect circular dependencies in a batch of JobSpecs being published together.
 *
 * The graph is: outputDatasetRid → set(inputDatasetRid). A cycle exists if
 * any output is reachable from itself via the outputs being published.
 *
 * Direct cycle: spec A's output is in spec A's inputs.
 * Transitive cycle: spec A output is spec B input AND spec B output is spec A input.
 */
export function detectCircularDependencies(
  batch: ReadonlyArray<JobSpecPayload>,
): ValidationResult {
  // Build graph: output → set of input outputs that are also published in this batch.
  const outputs = new Set<string>();
  for (const s of batch) outputs.add(s.outputDatasetRid);
  const adj = new Map<string, string[]>();
  for (const s of batch) {
    const next: string[] = [];
    for (const inp of s.inputs) {
      if (outputs.has(inp.datasetRid)) next.push(inp.datasetRid);
    }
    adj.set(s.outputDatasetRid, next);
  }
  // Direct self-cycle (output in own inputs).
  for (const s of batch) {
    for (const inp of s.inputs) {
      if (inp.datasetRid === s.outputDatasetRid) {
        return {
          ok: false,
          errorName: "JobSpec:CircularDependency",
          parameters: { reason: "self-loop", outputDatasetRid: s.outputDatasetRid },
        };
      }
    }
  }
  // DFS-based cycle detection (white/gray/black).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adj.keys()) color.set(k, WHITE);
  let cycleNode: string | null = null;
  const path: string[] = [];
  function dfs(node: string): boolean {
    color.set(node, GRAY);
    path.push(node);
    const neighbours = adj.get(node) ?? [];
    for (const n of neighbours) {
      const c = color.get(n) ?? WHITE;
      if (c === GRAY) {
        cycleNode = n;
        return true;
      }
      if (c === WHITE && dfs(n)) return true;
    }
    color.set(node, BLACK);
    path.pop();
    return false;
  }
  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      if (dfs(node)) {
        const idx = path.indexOf(cycleNode!);
        const cycle = path.slice(idx).concat(cycleNode!);
        return {
          ok: false,
          errorName: "JobSpec:CircularDependency",
          parameters: { reason: "transitive-cycle", cycle },
        };
      }
    }
  }
  return { ok: true };
}
