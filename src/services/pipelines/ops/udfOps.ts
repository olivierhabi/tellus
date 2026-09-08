// ---------------------------------------------------------------------------
// UDF op — user-authored transform (FOUNDRY-GAPS §2), extracted from
// transformService.ts.
//
// A UDF is the one transform that cannot compile to engine SQL: it is
// arbitrary user code. It is stored on the node's `config.udfTransform`
// slot — deliberately NOT in `config.transforms` so the Trino/DuckDB
// compilers never try to fold it — and executed inside the gVisor sandbox
// proven in §1/§3 (a Kubernetes Job pinned to the `gvisor` RuntimeClass,
// hardened pod, deny-all egress). There is no in-process eval path: running
// user code unsandboxed is exactly the risk the substrate work removed.
// ---------------------------------------------------------------------------

import { validateUdfSpec } from '../udfTransform';
import { runUdfTransform } from '../udfRunner';
import { sampleInfo } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

/**
 * Persist a UDF transform onto a node. Validates the spec (language allow-
 * list, code size, entrypoint identifier, timeout bounds) before storing it.
 */
export async function udfApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: unknown,
) {
  const spec = validateUdfSpec(input);
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);

  node.config.udfTransform = { ...spec, createdAt: new Date().toISOString() };

  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

/**
 * Preview a UDF: resolve the node's input rows (the existing CSV + prior
 * transform chain), then execute the user code over a bounded slice inside
 * the gVisor sandbox and return the transformed rows. Requires the sandbox
 * runtime (TELLUS_UDF_RUNTIME=k8s); otherwise surfaces a typed 503 so the
 * UI can explain that the substrate isn't wired in this environment.
 */
export async function udfPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: unknown,
  limit = 100,
) {
  const spec = validateUdfSpec(input);
  const { existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(
    projectId, pipelineId, nodeId,
  );
  const rows = ctx.applyExistingTransforms(rawRows, existingTransforms)
    .slice(0, limit);

  const out = await runUdfTransform({
    buildRid: `udf-preview-${pipelineId}-${nodeId}`,
    tenant: projectId,
    spec,
    rows,
  });

  const columns = spec.outputColumns.length
    ? spec.outputColumns
    : Object.keys(out[0] ?? {}).map((name) => ({ name, type: 'string' }));
  return {
    columns,
    rows: out,
    rowCount: out.length,
    ...sampleInfo(rawRows.length),
  };
}
