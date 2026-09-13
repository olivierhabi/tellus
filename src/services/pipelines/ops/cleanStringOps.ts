// ---------------------------------------------------------------------------
// Clean String op — Palantir `cleanStringV1` parity.
// Reference: https://www.palantir.com/docs/foundry/pb-functions-expression/cleanStringV1
//
// Actions (combinable):
//   trim                — remove leading/trailing whitespace
//   normalizeWhitespace — collapse internal whitespace runs to one space
//   nullifyEmpty        — empty strings (after the other actions) become null
// ---------------------------------------------------------------------------

import type {
  CleanStringActions,
  CleanStringPreviewInput,
  CleanStringApplyInput,
} from '../../../types/pipeline';
import { sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

// ---------------------------------------------------------------------------
// Pure row transform (chain-replay semantics)
// ---------------------------------------------------------------------------

function cleanValue(value: unknown, actions: CleanStringActions): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  let out = value;
  if (actions.trim) out = out.trim();
  if (actions.normalizeWhitespace) out = out.replace(/\s+/g, ' ');
  if (actions.nullifyEmpty && out === '') return null;
  return out;
}

/**
 * Apply the clean actions to the chosen columns of every row. When
 * `columns` is omitted/empty every column is cleaned (Palantir's Clean
 * string board transform defaults to the whole row).
 */
export function applyCleanStringRows(
  rows: Array<Record<string, unknown>>,
  columns: string[] | undefined,
  actions: CleanStringActions,
): Array<Record<string, unknown>> {
  const wanted = columns && columns.length > 0 ? new Set(columns.map(stripBom)) : null;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = wanted === null || wanted.has(stripBom(k)) ? cleanValue(v, actions) : v;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Preview / apply entry points
// ---------------------------------------------------------------------------

export async function cleanStringPreview(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: CleanStringPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const transformed = applyCleanStringRows(rows, input.columns, input.actions).slice(0, input.limit);

  // Clean String never changes the schema — values only.
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);

  const activeActions = (Object.keys(input.actions) as Array<keyof CleanStringActions>)
    .filter((k) => input.actions[k]);
  return {
    columns: effectiveColumns,
    rows: transformed,
    rowCount: transformed.length,
    ...sampleInfo(rawRows.length),
    renameSummary: `Cleaned ${input.columns?.length ?? effectiveColumns.length} column(s): ${activeActions.join(', ') || 'no actions'}`,
  };
}

export async function cleanStringApply(
  ctx: TransformOpsContext,
  projectId: string, pipelineId: string, nodeId: string,
  input: CleanStringApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'CleanString',
    columns: input.columns,
    actions: input.actions,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
