// ---------------------------------------------------------------------------
// Dedupe ops (Palantir dropDuplicatesV1 / keepDuplicatesV1) — extracted from
// transformService.ts.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type {
  DropDuplicatesPreviewInput,
  DropDuplicatesApplyInput,
  KeepDuplicatesPreviewInput,
  KeepDuplicatesApplyInput,
} from '../../../types/pipeline';
import { sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

/**
 * dropDuplicatesV1 core: keep the FIRST row per key. When `keyCols` is null
 * the key is the entire row (every column must match to be a duplicate).
 */
export function applyDropDuplicates(
  rows: Array<Record<string, unknown>>,
  keyCols: string[] | null,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    let key: string;
    if (keyCols) {
      key = keyCols.map((c) => String(row[c] ?? '')).join('\u0001');
    } else {
      key = Object.keys(row).sort().map((k) => `${k}=${row[k] ?? ''}`).join('\u0001');
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** keepDuplicatesV1 core: key-frequency filter, original order preserved. */
export function computeKeepDuplicates(
  rows: Array<Record<string, unknown>>,
  subset: string[],
  allColumns: string[],
): Array<Record<string, unknown>> {
  const keys = subset.length ? subset : allColumns;
  const keyOf = (row: Record<string, unknown>) => JSON.stringify(keys.map((c) => row[c] ?? null));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.filter((row) => (counts.get(keyOf(row)) ?? 0) > 1);
}

export async function dropDuplicatesPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: DropDuplicatesPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const keyCols = input.columns?.map(stripBom) ?? null;
  if (keyCols) {
    for (const c of keyCols) {
      if (!effectiveCols.some((ec) => stripBom(ec.name) === c)) {
        throw new AppError(
          `Deduplicate key column "${c}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
          400,
          'VALIDATION_ERROR',
        );
      }
    }
  }

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const deduped = applyDropDuplicates(rows, keyCols);
  const sliced = deduped.slice(0, input.limit);
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  return {
    columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
    rows: sliced,
    rowCount: sliced.length,
    ...sampleInfo(rawRows.length),
    totalRows: rows.length,
    duplicatesRemoved: rows.length - deduped.length,
    dedupeSummary: keyCols ? `By ${keyCols.join(', ')}` : 'By all columns',
  };
}

export async function dropDuplicatesApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: DropDuplicatesApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'DropDuplicates',
    columns: input.columns,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

export async function keepDuplicatesPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: KeepDuplicatesPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  // Omitting `columns` = exact-duplicate mode (key = every column).
  const subset = input.columns ?? [];
  ctx.assertColumnsExist(effectiveNames, subset, 'KeepDuplicates');

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const allNames = effectiveColumns.map((c) => c.name);
  const rows = computeKeepDuplicates(chained, subset, allNames).slice(0, input.limit);

  return {
    columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    keepDuplicatesSummary: `Keeping rows where (${subset.join(', ') || 'all columns'}) appears > 1 time`,
  };
}

export async function keepDuplicatesApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: KeepDuplicatesApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'KeepDuplicates',
    columns: input.columns,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
