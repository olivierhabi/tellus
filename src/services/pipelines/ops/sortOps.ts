// ---------------------------------------------------------------------------
// Sort op (Palantir sortV2) and Top Rows op (topRowsV1) — extracted from
// transformService.ts. Both share the stable multi-key ordering core.
// ---------------------------------------------------------------------------

import { AppError } from '../../../utils/foundryAppError';
import type { SortPreviewInput, SortApplyInput, TopRowsPreviewInput, TopRowsApplyInput } from '../../../types/pipeline';
import { coerceNumeric, sampleInfo, stripBom } from './shared';
import type { TransformOpsContext } from './transformOpsContext';

export interface SortKey {
  column: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}

/**
 * Stable multi-key sort. Nulls are ordered first or last per SortKey.nulls
 * (default: 'last' for ascending, 'first' for descending — the SQL-standard
 * default in DuckDB/Postgres).
 */
export function applySort(
  rows: Array<Record<string, unknown>>,
  sorts: SortKey[],
): Array<Record<string, unknown>> {
  const withIdx = rows.map((row, idx) => ({ row, idx }));
  withIdx.sort((a, b) => {
    for (const k of sorts) {
      const av = a.row[k.column];
      const bv = b.row[k.column];
      const aNull = av === null || av === undefined || av === '';
      const bNull = bv === null || bv === undefined || bv === '';
      if (aNull && bNull) continue;
      const nullsFirst = k.nulls === 'first' ? true : k.nulls === 'last' ? false : k.direction === 'desc';
      if (aNull) return nullsFirst ? -1 : 1;
      if (bNull) return nullsFirst ? 1 : -1;
      const an = coerceNumeric(av);
      const bn = coerceNumeric(bv);
      let cmp: number;
      if (an !== null && bn !== null) cmp = an < bn ? -1 : an > bn ? 1 : 0;
      else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      if (cmp !== 0) return k.direction === 'desc' ? -cmp : cmp;
    }
    // Stable: preserve original index for ties.
    return a.idx - b.idx;
  });
  return withIdx.map((x) => x.row);
}

/** topRowV2 core: partition → per-partition sort → first N rows. Mirror
 * of the DuckDB engine's ROW_NUMBER() OVER (PARTITION … ORDER BY …). */
export function computeTopRows(
  rows: Array<Record<string, unknown>>,
  partitionBy: string[],
  sorts: SortKey[],
  topN: number,
): Array<Record<string, unknown>> {
  if (partitionBy.length === 0) {
    return applySort(rows, sorts).slice(0, topN);
  }
  const groups = new Map<string, Array<Record<string, unknown>>>();
  const order: string[] = [];
  for (const row of rows) {
    const key = JSON.stringify(partitionBy.map((c) => row[c] ?? null));
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const key of order) {
    out.push(...applySort(groups.get(key) ?? [], sorts).slice(0, topN));
  }
  return out;
}

export async function sortPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: SortPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveCols = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  for (const k of input.sorts) {
    const c = stripBom(k.column);
    if (!effectiveCols.some((ec) => stripBom(ec.name) === c)) {
      throw new AppError(
        `Sort column "${c}" does not exist. Available: ${effectiveCols.map((ec) => ec.name).join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
  }

  const rows = ctx.applyExistingTransforms(rawRows, chainTransforms);

  const sorted = applySort(rows, input.sorts);
  const sliced = sorted.slice(0, input.limit);

  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  return {
    columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
    rows: sliced,
    rowCount: sliced.length,
    ...sampleInfo(rawRows.length),
    totalRows: rows.length,
    sortSummary: input.sorts.map((s) => `${s.column} ${s.direction.toUpperCase()}`).join(', '),
  };
}

export async function sortApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: SortApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'Sort',
    sorts: input.sorts,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}

export async function topRowsPreview(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: TopRowsPreviewInput,
) {
  const { sourceColumns, existingTransforms, baseRows: rawRows } = await ctx.resolvePreviewInput(projectId, pipelineId, nodeId);
  const chainTransforms = input.priorTransforms ?? existingTransforms;
  const effectiveColumns = ctx.applyExistingTransformColumns(sourceColumns, chainTransforms);
  const effectiveNames = new Set(effectiveColumns.map((c) => c.name));
  if (input.sorts.length === 0) {
    throw new AppError('Top Rows requires at least one sort column', 400, 'VALIDATION_ERROR');
  }
  ctx.assertColumnsExist(effectiveNames, [...input.partitionBy, ...input.sorts.map((s) => s.column)], 'TopRows');

  const chained = ctx.applyExistingTransforms(rawRows, chainTransforms);
  const rows = computeTopRows(chained, input.partitionBy, input.sorts, input.topN).slice(0, input.limit);

  return {
    columns: effectiveColumns.map((c) => ({ name: c.name, type: c.type })),
    rows,
    rowCount: rows.length,
    ...sampleInfo(rawRows.length),
    topRowSummary: `Top ${input.topN} rows per ${input.partitionBy.length ? `[${input.partitionBy.join(', ')}]` : 'table'}`,
  };
}

export async function topRowsApply(
  ctx: TransformOpsContext,
  projectId: string,
  pipelineId: string,
  nodeId: string,
  input: TopRowsApplyInput,
) {
  const node = await ctx.fetchNodeConfig(projectId, pipelineId, nodeId);
  const transforms: unknown[] = Array.isArray(node.config.transforms) ? node.config.transforms : [];
  transforms.push({
    function: 'TopRows',
    partitionBy: input.partitionBy,
    sorts: input.sorts,
    topN: input.topN,
    createdAt: new Date().toISOString(),
  });
  node.config.transforms = transforms;
  return ctx.saveNodeConfig(nodeId, pipelineId, node.config);
}
